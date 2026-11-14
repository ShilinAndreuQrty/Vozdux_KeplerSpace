import asyncio
import csv
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from time import monotonic
from urllib.parse import quote, urlencode

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from archive import ESI_MODEL, EXAMPLE, HZ_MODEL, fetch_catalog, load_catalog, planet_context, save_catalog


BASE_DIR = Path(__file__).resolve().parent
MOSCOW = timezone(timedelta(hours=3))
logger = logging.getLogger("uvicorn.error")

SECTIONS = {
    "": {"title": "Солнечная система"},
    "exoplanets": {
        "title": "Экзопланеты",
    },
    "three-body": {
        "title": "Задача трёх тел",
        "description": "Меняйте массы, координаты и начальные скорости и наблюдайте, как три тела движутся под действием гравитации.",
    },
    "constellations": {
        "title": "Созвездия",
        "description": "Здесь появится карта звёздного неба с выбором места и времени наблюдения.",
        "future": True,
    },
    "black-holes": {
        "title": "Чёрные дыры",
        "description": "Здесь появится учебная визуализация орбит и искривления света вблизи чёрной дыры.",
        "future": True,
    },
}

PLANETS = (
    ("sun", "Солнце", "#ffc185"),
    ("mercury", "Меркурий", "#c5aa9e"),
    ("venus", "Венера", "#eccc90"),
    ("earth", "Земля", "#8cc9ff"),
    ("mars", "Марс", "#e08a68"),
    ("jupiter", "Юпитер", "#e0af90"),
    ("saturn", "Сатурн", "#f6d6a1"),
    ("uranus", "Уран", "#99e4e5"),
    ("neptune", "Нептун", "#83a9fb"),
)

NASA_PLANET_PARADES = "https://science.nasa.gov/solar-system/skywatching/planetary-alignments-and-planet-parades/"
SOLAR_EVENTS = (
    {
        "date": "2025-01-25T18:00", "label": "Январь — середина февраля 2025 · Вечерний парад",
        "description": "Венера, Сатурн, Юпитер и Марс были видны на вечернем небе.",
        "bodies": "venus saturn jupiter mars", "source": NASA_PLANET_PARADES,
    },
    {
        "date": "2025-08-23T05:00", "label": "Конец августа 2025 · Утренний парад",
        "description": "Перед восходом были видны Меркурий, Венера, Юпитер и Сатурн.",
        "bodies": "mercury venus jupiter saturn", "source": NASA_PLANET_PARADES,
    },
    {
        "date": "2026-02-24T18:00", "label": "24 февраля 2026 · Вечерний парад",
        "description": "На этой неделе после заката были видны Венера, Меркурий, Сатурн и Юпитер. Для Урана и Нептуна нужна была оптика.",
        "bodies": "venus mercury saturn neptune uranus jupiter",
        "source": "https://science.nasa.gov/image-article/apod-2026-february-24-planet-parade-over-sydney-opera-house/",
    },
    {
        "date": "2026-06-09T21:00", "label": "9 июня 2026 · Венера и Юпитер",
        "description": "Венера и Юпитер были видны рядом на вечернем небе.",
        "bodies": "venus jupiter",
        "source": "https://science.nasa.gov/image-article/apod-2026-june-12-venus-and-jupiter-conjunction-from-avebury/",
    },
    {
        "date": "2028-10-25T06:00", "label": "Конец октября 2028 · Утренний парад",
        "description": "NASA указывает окно, когда перед восходом можно будет увидеть пять планет.",
        "bodies": "mercury venus jupiter mars saturn", "source": NASA_PLANET_PARADES,
    },
    {
        "date": "2034-02-25T18:00", "label": "Конец февраля 2034 · Вечерний парад",
        "description": "NASA указывает вечернее окно в конце месяца. На выбранной дате Меркурий находится с утренней стороны Солнца.",
        "bodies": "venus jupiter mars saturn", "source": NASA_PLANET_PARADES,
        "ephemeris": (
            "https://ssd.jpl.nasa.gov/api/horizons.api?format=text&COMMAND=199&CENTER=500%40399"
            "&EPHEM_TYPE=OBSERVER&START_TIME=2034-02-22&STOP_TIME=2034-03-03"
            "&STEP_SIZE=1d&QUANTITIES=23&CSV_FORMAT=YES"
        ),
    },
)

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.catalog = load_catalog()
    app.state.refresh_lock = asyncio.Lock()
    app.state.last_attempt = float("-inf")
    yield


def format_number(value, digits=2):
    if value is None:
        return "—"
    if 0 < abs(value) < 10 ** -digits:
        digits = max(digits, 5)
    result = f"{value:,.{digits}f}"
    if digits:
        result = result.rstrip("0").rstrip(".")
    return result.replace(",", " ").replace(".", ",")


app = FastAPI(title="KeplerSpace", openapi_url=None, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")
templates.env.globals["sections"] = SECTIONS
templates.env.globals["hz_model"] = HZ_MODEL
templates.env.globals["esi_model"] = ESI_MODEL
templates.env.filters["number"] = format_number
templates.env.filters["query"] = lambda value: urlencode({"planet": value}, quote_via=quote)


@app.get("/", response_class=HTMLResponse, name="home")
async def home(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        request=request,
        name="home.html",
        context={"active_slug": "", "planets": PLANETS, "events": SOLAR_EVENTS},
    )


@app.get("/exoplanets", response_class=HTMLResponse, name="exoplanets")
async def exoplanets(request: Request, planet: str | None = None) -> HTMLResponse:
    catalog = request.app.state.catalog
    context = {"active_slug": "exoplanets", "catalog": catalog}
    if catalog:
        planets = catalog["planets"]
        name = planet if planet in planets else catalog["ranking"][0]
        fetched_at = datetime.fromisoformat(catalog["fetched_at"]).astimezone(MOSCOW)
        context.update(
            **planet_context(catalog, name),
            ranking=[planets[item] for item in catalog["ranking"]],
            fetched_at=fetched_at.strftime("%d.%m.%Y · %H:%M МСК"),
            example=EXAMPLE if EXAMPLE in planets else None,
        )
    return templates.TemplateResponse(
        request=request,
        name="catalog.html",
        context=context,
    )


@app.get("/exoplanets/card", response_class=HTMLResponse, name="exoplanet_card")
async def exoplanet_card(request: Request, planet: str) -> HTMLResponse:
    catalog = request.app.state.catalog
    if not catalog or planet not in catalog["planets"]:
        raise HTTPException(status_code=404, detail="Планета не найдена в каталоге.")
    return templates.TemplateResponse(
        request=request,
        name="planet_card.html",
        context=planet_context(catalog, planet),
    )


@app.post("/exoplanets/refresh", name="refresh_catalog")
async def refresh_catalog(request: Request) -> JSONResponse:
    state = request.app.state
    if state.refresh_lock.locked():
        return JSONResponse({"message": "Выгрузка NASA уже загружается."}, status_code=409)
    if monotonic() - state.last_attempt < 30:
        return JSONResponse({"message": "Повтори попытку через несколько секунд."}, status_code=429)
    async with state.refresh_lock:
        state.last_attempt = monotonic()
        try:
            catalog = await asyncio.to_thread(fetch_catalog)
            await asyncio.to_thread(save_catalog, catalog)
        except (OSError, ValueError, KeyError, csv.Error) as error:
            logger.warning("NASA Exoplanet Archive refresh failed: %s", error)
            return JSONResponse({"message": "Обновление NASA сейчас недоступно."}, status_code=503)
        state.catalog = catalog
    return JSONResponse({"fetched_at": catalog["fetched_at"]})


@app.get("/{slug}", response_class=HTMLResponse, name="section")
async def section(request: Request, slug: str) -> HTMLResponse:
    if not slug or slug not in SECTIONS:
        raise HTTPException(status_code=404, detail="Страница не найдена")

    if slug == "three-body":
        return templates.TemplateResponse(
            request=request,
            name="three_body.html",
            context={"active_slug": slug, "is_3d": request.query_params.get("mode") == "3d"},
        )

    return templates.TemplateResponse(
        request=request,
        name="section.html",
        context={"active_slug": slug},
    )
