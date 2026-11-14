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

from archive import EXAMPLE, HZ_MODEL, fetch_catalog, load_catalog, planet_context, save_catalog


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
        "description": "В этой лаборатории можно будет менять начальные условия и наблюдать, как три тела движутся под действием гравитации.",
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
templates.env.filters["number"] = format_number
templates.env.filters["query"] = lambda value: urlencode({"planet": value}, quote_via=quote)


@app.get("/", response_class=HTMLResponse, name="home")
async def home(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        request=request,
        name="home.html",
        context={"active_slug": "", "planets": PLANETS},
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

    return templates.TemplateResponse(
        request=request,
        name="section.html",
        context={"active_slug": slug},
    )
