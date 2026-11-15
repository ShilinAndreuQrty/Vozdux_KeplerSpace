import argparse
import csv
import io
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timezone
from functools import lru_cache
from html.parser import HTMLParser
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import quote, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen

from draft_math import central, evaluate_planet, habitable_zone, orbit_summary, positive

ARCHIVE = "https://exoplanetarchive.ipac.caltech.edu"
CALCULATIONS = ARCHIVE + "/docs/pscp_calc.html"
HZ_MODEL = "https://arxiv.org/abs/2611.09475"
ESI_MODEL = "https://phl.upr.edu/projects/earth-similarity-index-esi"
DATA_DIR = Path(__file__).resolve().parent / "data"
BUNDLED = DATA_DIR / "catalog.json"
LOCAL = DATA_DIR / "catalog.local.json"
EXAMPLE = "55 Cnc e"
TOP_COUNT = 50
CATALOG_VERSION = 6
LIGHT_YEARS_PER_PC = 3.26156

FIELDS = {
    "radius": "pl_rade",
    "flux": "pl_insol",
    "mass": "pl_bmasse",
    "axis": "pl_orbsmax",
    "eccentricity": "pl_orbeccen",
    "period": "pl_orbper",
    "equilibrium_temperature": "pl_eqt",
    "star_temperature": "st_teff",
    "star_log_luminosity": "st_lum",
    "star_radius": "st_rad",
    "star_mass": "st_mass",
    "star_rotation": "st_rotp",
}
REQUIRED_COLUMNS = (
    "pl_name", "hostname", "discoverymethod", "disc_year", "pl_controv_flag", "cb_flag",
    "sy_snum", "sy_dist", "pl_bmassj", "pl_bmassprov", "st_spectype",
    "st_spectype_reflink", "st_logg", "pl_ntranspec", "pl_nespec", "pl_ndispec",
    "pl_orbeccenerr1", "pl_radeerr1", "pl_radeerr2", "pl_insolerr1", "pl_insolerr2",
    "pl_bmasseerr1", "pl_bmasseerr2",
    *(column + suffix for column in FIELDS.values() for suffix in ("", "lim", "_reflink")),
)
COLUMNS = REQUIRED_COLUMNS + (
    "pl_orbsmaxerr1", "pl_orbsmaxerr2", "pl_orbeccenerr2", "pl_orbpererr1", "pl_orbpererr2",
    "pl_eqterr1", "pl_eqterr2", "st_tefferr1", "st_tefferr2", "st_lumerr1", "st_lumerr2",
)
FIELD_LABELS = {
    "radius": "радиус",
    "mass": "полная масса",
    "density": "средняя плотность",
    "escape_velocity": "скорость убегания",
    "axis": "большая полуось",
    "eccentricity": "эксцентриситет орбиты",
    "star_temperature": "температура звезды",
    "star_luminosity": "светимость звезды",
    "surface_temperature": "температура поверхности",
}

DISCOVERY_METHODS = {
    "Transit": "Транзит",
    "Radial Velocity": "Лучевые скорости",
    "Transit Timing Variations": "Вариации времени транзита",
    "Imaging": "Прямое наблюдение",
    "Microlensing": "Микролинзирование",
    "Pulsar Timing": "Тайминг пульсара",
    "Eclipse Timing Variations": "Вариации времени затмений",
    "Astrometry": "Астрометрия",
}

WEBB_TRAPPIST = (
    "https://science.nasa.gov/mission/webb/science-overview/science-explainers/"
    "what-is-webb-revealing-about-the-trappist-1-system/"
)
ACTIVITY_NOTES = {
    "Teegarden's Star": (
        "В наблюдениях TESS зарегистрированы вспышки. В остальное время активность звезды обычно низкая.",
        "https://arxiv.org/abs/2504.02338",
    ),
    "TRAPPIST-1": ("Наблюдались вспышки и звёздные пятна. Они затрудняют анализ спектров планет.", WEBB_TRAPPIST),
    "Proxima Cen": (
        "Наблюдались частые вспышки, в том числе мощная вспышка в ультрафиолетовом диапазоне.",
        "https://science.nasa.gov/universe/exoplanets/neighboring-stars-bad-behavior-large-and-frequent-flares/",
    ),
    "TOI-700": (
        "За 11 секторов наблюдений TESS в видимом свете вспышек не зарегистрировали.",
        "https://arxiv.org/abs/2001.00952",
    ),
    "Kepler-438": (
        "На кривой блеска, полученной телескопом Kepler, обнаружены мощные вспышки.",
        "https://arxiv.org/abs/1511.05306",
    ),
    "Ross 128": (
        "По спектральным признакам звезда проявляет низкую активность.",
        "https://arxiv.org/abs/1711.06177",
    ),
}
ATMOSPHERE_NOTES = {
    "TRAPPIST-1 b": ("Измерения Webb согласуются с моделью практически без атмосферы.", WEBB_TRAPPIST, 0),
    "TRAPPIST-1 c": ("Наблюдения Webb ограничивают возможность плотной атмосферы.", WEBB_TRAPPIST, 0),
    "TRAPPIST-1 d": (
        "В спектре Webb не обнаружили признаков атмосферы земного типа. Данные допускают очень тонкую атмосферу или высокие облака.",
        "https://doi.org/10.3847/1538-4357/adf207",
        0,
    ),
    "TRAPPIST-1 e": ("Данные Webb исключают плотную водородную атмосферу. Другие варианты изучаются.", WEBB_TRAPPIST, 0),
    EXAMPLE: (
        "Спектры Webb указывают на возможную атмосферу с углекислым газом или монооксидом углерода.",
        "https://science.nasa.gov/missions/webb/nasas-webb-hints-at-possible-atmosphere-surrounding-rocky-exoplanet/",
        0.52,
    ),
}
CLASSIFIED_GIANTS = {"55 Cnc b", "55 Cnc c", "55 Cnc d", "55 Cnc f"}


class ReferenceParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.label = []
        self.href = ""

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.href = dict(attrs).get("href") or ""

    def handle_data(self, data):
        self.label.append(data)


@lru_cache(maxsize=4096)
def reference(raw):
    if not raw:
        return None
    parser = ReferenceParser()
    parser.feed(raw)
    label = "".join(parser.label).strip()
    href = urljoin(ARCHIVE, parser.href) if parser.href else None
    if href and urlparse(href).scheme != "https":
        href = None
    return {"label": label, "url": href}


def number(row, key):
    try:
        value = float(row.get(key))
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def metric(row, field):
    column = FIELDS[field]
    value = number(row, column)
    if value is None:
        return None
    source = reference(row.get(column + "_reflink"))
    limit = number(row, column + "lim")
    plus = number(row, column + "err1")
    minus = number(row, column + "err2")
    kind = "published" if source and source["label"] else "unknown"
    if source and source["label"].casefold() == "calculated value":
        source = {"label": "Расчёт NASA Exoplanet Archive", "url": CALCULATIONS}
        kind = "archive_estimate"
    elif field == "equilibrium_temperature":
        kind = "model"
    elif field == "mass":
        provenance = "".join(char for char in (row.get("pl_bmassprov") or "").casefold() if char.isalnum())
        if provenance == "msini":
            kind = "minimum"
        elif provenance in {"msinisini", "mrrelationship"}:
            kind = "model"
        elif provenance != "mass":
            kind = "unknown"
    elif field == "eccentricity" and value == 0 and not limit and not (plus or minus):
        kind = "assumption"
    return {"value": value, "kind": kind, "limit": limit or 0, "source": source, "plus": plus, "minus": minus}


def estimate(value, label, url):
    return {
        "value": value, "kind": "model", "limit": 0,
        "source": {"label": label, "url": url}, "plus": None, "minus": None,
    }


def planet_metrics(row):
    metrics = {field: metric(row, field) for field in FIELDS}
    # Для полного ESI нужна температура поверхности. В PSCompPars есть равновесная.
    metrics["surface_temperature"] = None
    circumbinary = row["cb_flag"] == "1"
    axis = central(metrics["axis"])
    if axis and row["discoverymethod"] in {"Microlensing", "Imaging"}:
        # В этом поле может быть проекция расстояния вместо полуоси.
        metrics["axis"] = None
        axis = None
    if not positive(axis) and not circumbinary:
        period = central(metrics["period"])
        star_mass = central(metrics["star_mass"])
        if positive(period) and positive(star_mass):
            metrics["axis"] = estimate(
                (star_mass * (period / 365.25) ** 2) ** (1 / 3),
                "Расчёт из периода и массы звезды по третьему закону Кеплера",
                None,
            )
            axis = central(metrics["axis"])
    log_field = metrics.pop("star_log_luminosity")
    luminosity_log = central(log_field)
    star_radius = central(metrics["star_radius"])
    star_temperature = central(metrics["star_temperature"])
    if luminosity_log is not None:
        luminosity = 10 ** luminosity_log
        metrics["star_luminosity"] = {
            **log_field, "value": luminosity,
            **{key: luminosity * math.expm1(log_field[key] * math.log(10)) if log_field[key] is not None else None
               for key in ("plus", "minus")},
        }
    elif positive(star_radius) and positive(star_temperature):
        metrics["star_luminosity"] = estimate(
            star_radius ** 2 * (star_temperature / 5772) ** 4,
            "Расчёт из радиуса и температуры звезды",
            CALCULATIONS,
        )
    else:
        metrics["star_luminosity"] = None
    luminosity = central(metrics["star_luminosity"])
    if metrics["flux"] is None and positive(luminosity) and positive(axis) and not circumbinary:
        metrics["flux"] = estimate(luminosity / axis ** 2, "Расчёт из светимости и большой полуоси", CALCULATIONS)
    return metrics


def build_catalog(rows, fetched_at, retained_hosts=()):
    if len(rows) < 1000 or len({row.get("pl_name") for row in rows}) != len(rows):
        raise ValueError("NASA вернула неполную таблицу или повторяющиеся записи.")
    if not set(REQUIRED_COLUMNS).issubset(rows[0]):
        raise ValueError("Структура таблицы NASA изменилась.")

    systems = defaultdict(dict)
    ranking = []
    for row in rows:
        if row["pl_controv_flag"] == "1" or not row["pl_name"] or not row["hostname"]:
            continue
        metrics = planet_metrics(row)
        name, host = row["pl_name"], row["hostname"]
        spectral_type = row["st_spectype"] or None
        circumbinary = row["cb_flag"] == "1"
        zone = habitable_zone(
            central(metrics["star_temperature"]), central(metrics["star_luminosity"]),
            circumbinary, spectral_type, number(row, "st_logg"),
        )
        eccentricity = metrics["eccentricity"]
        measured_e = central(eccentricity) if eccentricity and eccentricity["kind"] == "published" else None
        axis = None if circumbinary else central(metrics["axis"])
        orbit = orbit_summary(axis, measured_e, zone)
        giant = giant_kind(row, metrics)
        evaluation = evaluate_planet(metrics, zone, orbit, giant)
        priority = evaluation["priority"]
        if priority is not None:
            ranking.append((name, host, priority["score"]))
        distance = number(row, "sy_dist")
        systems[host][name] = {
            "name": name, "host": host, "rank": None, **evaluation,
            "distance": distance * LIGHT_YEARS_PER_PC if distance is not None else None,
            "method": DISCOVERY_METHODS.get(row["discoverymethod"], row["discoverymethod"]),
            "year": int(row["disc_year"]) if row["disc_year"] else None,
            "metrics": metrics, "zone": zone, "giant": giant,
            "orbit": orbit, "circumbinary": circumbinary,
            "spectral_type": spectral_type,
            "spectral_source": reference(row["st_spectype_reflink"]),
            "stars": int(row["sy_snum"] or 0),
            "spectra": sum(int(row[column] or 0) for column in ("pl_ntranspec", "pl_nespec", "pl_ndispec")),
        }

    ranking.sort(key=lambda entry: (-entry[2], entry[0].casefold()))
    top = [name for name, _, _ in ranking[:TOP_COUNT]]
    hosts = {host for _, host, _ in ranking[:TOP_COUNT]}
    hosts.update(systems.keys() & set(retained_hosts))
    if EXAMPLE in systems.get("55 Cnc", {}):
        hosts.add("55 Cnc")
    planets = {name: planet for host in sorted(hosts) for name, planet in systems[host].items()}
    for rank, name in enumerate(top, 1):
        planets[name]["rank"] = rank
    if len(top) != TOP_COUNT:
        raise ValueError("В выгрузке недостаточно данных для топ-50.")
    return {
        "version": CATALOG_VERSION,
        "fetched_at": fetched_at.isoformat(timespec="seconds"),
        "archive_count": len(rows), "eligible_count": len(ranking),
        "ranking": top, "planets": planets,
    }


def giant_kind(row, metrics):
    if row["pl_name"] in CLASSIFIED_GIANTS:
        return "classified"
    mass = number(row, "pl_bmassj")
    radius = central(metrics["radius"])
    if (mass is not None and mass >= 0.3 and central(metrics["mass"]) is not None) or (radius is not None and radius >= 8):
        return "probable"
    return None


def planet_context(catalog, name):
    planet = catalog["planets"][name]
    siblings = [item for item in catalog["planets"].values() if item["host"] == planet["host"]]
    siblings.sort(key=lambda item: (item["orbit"]["axis"] is None, item["orbit"]["axis"] or 0, item["name"]))
    count = len(siblings)
    ending = count % 10
    if 11 <= count % 100 <= 14 or ending == 0 or ending >= 5:
        phrase = "известных планет"
    else:
        phrase = "известная планета" if ending == 1 else "известные планеты"
    return {
        "planet": planet,
        "siblings": siblings,
        "known_planets": f"{count} {phrase}",
        "distances": distance_chart(planet, siblings),
        "activity": ACTIVITY_NOTES.get(planet["host"]),
        "atmosphere": ATMOSPHERE_NOTES.get(name),
        "field_labels": FIELD_LABELS,
        "archive_url": ARCHIVE + "/overview/" + quote(name, safe=""),
    }


def distance_chart(planet, siblings):
    zone = planet["zone"]
    entries = [(item, item["orbit"]) for item in siblings if item["orbit"]["axis"] and item["orbit"]["axis"] > 0]
    if not entries and not zone["available"]:
        return None
    edges = [zone["inner"], zone["outer"]] if zone["available"] else []
    distances = edges + [value for _, orbit in entries for value in
                         (orbit["near"] or orbit["axis"], orbit["far"] or orbit["axis"])]
    maximum = max(distances)
    minimum = min(distances)
    compressed = maximum / minimum > 6
    scale = 1 / minimum if compressed else 0

    def position(value):
        return 100 * (math.log1p(value * scale) / math.log1p(maximum * scale)
                      if compressed else value / maximum)

    ticks = [maximum * fraction for fraction in (0, .25, .5, .75, 1)]
    if compressed:
        ticks = [math.expm1(math.log1p(maximum * scale) * fraction) / scale
                 for fraction in (0, .25, .5, .75, 1)]
    return {
        "zone": [position(edge) for edge in edges],
        "compressed": compressed,
        "ticks": ticks,
        "rows": [
            {"planet": item, "marker": position(orbit["axis"]),
             "start": position(orbit["near"]) if orbit["near"] is not None else None,
             "end": position(orbit["far"]) if orbit["far"] is not None else None}
            for item, orbit in entries
        ],
    }


def read_csv(payload):
    return list(csv.DictReader(io.StringIO(payload.decode("utf-8-sig"), newline="")))


def retained_catalog_hosts():
    # Сохраняем ссылки на планеты из прошлых выпусков рейтинга.
    hosts = set()
    for path in (BUNDLED, LOCAL):
        try:
            with path.open(encoding="utf-8") as source:
                catalog = json.load(source)
            hosts.update(planet["host"] for planet in catalog["planets"].values())
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            continue
    return hosts


def fetch_catalog():
    query = "select " + ",".join(COLUMNS) + " from pscomppars"
    url = ARCHIVE + "/TAP/sync?" + urlencode({"query": query, "format": "csv", "maxrec": 30000})
    request = Request(url, headers={"User-Agent": "KeplerSpace/1.0"})
    with urlopen(request, timeout=20) as response:
        payload = response.read(25_000_001)
    if len(payload) > 25_000_000:
        raise ValueError("Выгрузка NASA превысила ожидаемый размер.")
    return build_catalog(read_csv(payload), datetime.now(timezone.utc), retained_catalog_hosts())


def save_catalog(catalog, path=None):
    path = LOCAL if path is None else path
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with NamedTemporaryFile(mode="w", dir=path.parent, encoding="utf-8", delete=False) as temporary:
            temporary_path = Path(temporary.name)
            json.dump(catalog, temporary, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            temporary.write("\n")
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def load_catalog():
    latest = None
    for path in (BUNDLED, LOCAL):
        try:
            with path.open(encoding="utf-8") as source:
                catalog = json.load(source)
            if catalog.get("version") != CATALOG_VERSION:
                continue
            date = datetime.fromisoformat(catalog["fetched_at"])
            if date.tzinfo is None or len(catalog["ranking"]) != TOP_COUNT:
                continue
            if any(name not in catalog["planets"] for name in catalog["ranking"]):
                continue
            if latest is None or date >= latest[0]:
                latest = (date, catalog)
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            continue
    return latest[1] if latest else None


def main():
    parser = argparse.ArgumentParser(description="Обновить каталог KeplerSpace из NASA Exoplanet Archive.")
    parser.add_argument("--csv", type=Path, help="Использовать сохранённую выгрузку PSCompPars.")
    parser.add_argument("--output", type=Path, default=LOCAL)
    args = parser.parse_args()
    if args.csv:
        fetched_at = datetime.fromtimestamp(args.csv.stat().st_mtime, timezone.utc)
        catalog = build_catalog(read_csv(args.csv.read_bytes()), fetched_at, retained_catalog_hosts())
    else:
        catalog = fetch_catalog()
    save_catalog(catalog, args.output)
    print(f"NASA: {catalog['archive_count']} / Ranked: {catalog['eligible_count']} / Top: {len(catalog['ranking'])}")


if __name__ == "__main__":
    main()
