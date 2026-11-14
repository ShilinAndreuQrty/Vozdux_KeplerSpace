import argparse
import csv
import io
import json
import math
import os
import re
from collections import defaultdict
from datetime import datetime, timezone
from functools import lru_cache
from html.parser import HTMLParser
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import quote, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen


ARCHIVE = "https://exoplanetarchive.ipac.caltech.edu"
CALCULATIONS = ARCHIVE + "/docs/pscp_calc.html"
HZ_MODEL = "https://arxiv.org/abs/2611.09475"
DATA_DIR = Path(__file__).resolve().parent / "data"
BUNDLED = DATA_DIR / "catalog.json"
LOCAL = DATA_DIR / "catalog.local.json"
EXAMPLE = "55 Cnc e"
TOP_COUNT = 50
CATALOG_VERSION = 3
LIGHT_YEARS_PER_PC = 3.26156

FIELDS = {
    "radius": "pl_rade",
    "flux": "pl_insol",
    "mass": "pl_bmasse",
    "axis": "pl_orbsmax",
    "eccentricity": "pl_orbeccen",
    "period": "pl_orbper",
    "temperature": "pl_eqt",
    "star_temperature": "st_teff",
    "star_log_luminosity": "st_lum",
    "star_radius": "st_rad",
    "star_mass": "st_mass",
    "star_rotation": "st_rotp",
}
COLUMNS = (
    "pl_name", "hostname", "discoverymethod", "disc_year", "pl_controv_flag", "cb_flag",
    "sy_snum", "sy_dist", "pl_bmassj", "pl_bmassprov", "st_spectype",
    "st_spectype_reflink", "st_logg", "pl_ntranspec", "pl_nespec", "pl_ndispec",
    "pl_orbeccenerr1", "pl_radeerr1", "pl_radeerr2", "pl_insolerr1", "pl_insolerr2",
    "pl_bmasseerr1", "pl_bmasseerr2",
    *(column + suffix for column in FIELDS.values() for suffix in ("", "lim", "_reflink")),
)

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
    raw = row.get(key)
    if raw is None or not raw.strip():
        return None
    value = float(raw)
    return value if math.isfinite(value) else None


def metric(row, field):
    column = FIELDS[field]
    value = number(row, column)
    if value is None:
        return None
    source = reference(row.get(column + "_reflink"))
    limit = number(row, column + "lim")
    kind = "archive_estimate" if source and source["label"].casefold() == "calculated value" else "published"
    if field == "temperature":
        kind = "archive_estimate" if kind == "archive_estimate" else "model"
    elif field == "mass" and kind == "published":
        provenance = row["pl_bmassprov"].casefold()
        if provenance in {"msini", "m*sini"}:
            kind = "minimum"
        elif "sin(i)" in provenance or provenance == "m-r relationship":
            kind = "model"
    elif field == "eccentricity" and value == 0 and not number(row, "pl_orbeccenerr1"):
        kind = "assumption"
    plus = number(row, column + "err1")
    minus = number(row, column + "err2")
    return {"value": value, "kind": kind, "limit": limit or 0, "source": source, "plus": plus, "minus": minus}


def central(field):
    return field["value"] if field is not None and not field["limit"] else None


def estimate(value, label, url):
    return {
        "value": value, "kind": "model", "limit": 0,
        "source": {"label": label, "url": url}, "plus": None, "minus": None,
    }


def esi_component(value, reference_value, weight):
    if value is None or reference_value <= 0 or value <= 0:
        return None

    similarity = 1 - abs(value - reference_value) / (value + reference_value)
    return similarity ** weight


def earth_similarity(radius, density, escape_velocity, surface_temperature=None):
    # Веса Schulze-Makuch et al. (2011)
    radius_esi = esi_component(radius, 1.0, 0.57)
    density_esi = esi_component(density, 5.514, 1.07)
    escape_esi = esi_component(escape_velocity, 11.186, 0.70)
    temperature_esi = esi_component(surface_temperature, 288.0, 5.58)

    interior = None
    if radius_esi is not None and density_esi is not None:
        interior = (radius_esi * density_esi) ** (1 / (0.57 + 1.07))

    surface = None
    if escape_esi is not None and temperature_esi is not None:
        surface = (escape_esi * temperature_esi) ** (1 / (0.70 + 5.58))

    # Полный ESI требует обеих групп параметров.
    score = (
        math.sqrt(interior * surface)
        if interior is not None and surface is not None
        else None
    )

    return {
        "score": score,
        "interior": interior,
        "surface": surface,
        "complete": score is not None,
    }

def physical_properties(metrics):
    radius_field = metrics["radius"]
    mass_field = metrics["mass"]

    radius = central(radius_field)
    mass = central(mass_field)

    reliable_mass = (
        mass is not None
        and mass > 0
        and mass_field["kind"] == "published"
    )
    reliable_radius = (
        radius is not None
        and radius > 0
        and radius_field["kind"] == "published"
    )

    density = None
    escape_velocity = None

    if reliable_mass and reliable_radius:
        density = 5.514 * mass / radius ** 3
        escape_velocity = 11.186 * math.sqrt(mass / radius)

    return {
        "radius": radius,
        "mass": mass,
        "density": density,
        "escape_velocity": escape_velocity,
        "density_available": density is not None,
        "escape_velocity_available": escape_velocity is not None,
    }

def data_confidence(metrics):
    fields = (
        "radius", "mass", "axis", "eccentricity",
        "period", "flux", "star_temperature", "star_luminosity",
    )

    available = [
        metrics[key]
        for key in fields
        if metrics.get(key) is not None
    ]

    published = sum(
        field["kind"] == "published"
        for field in available
    )

    estimated = sum(
        field["kind"] in {"model", "archive_estimate", "assumption"}
        for field in available
    )

    return {
        "available": len(available),
        "total": len(fields),
        "published": published,
        "estimated": estimated,
        "missing": len(fields) - len(available),
        "completeness": len(available) / len(fields),
    }

def habitable_zone(
    temperature,
    luminosity,
    circumbinary=False,
    spectral_type="",
    gravity=None,
):
    if circumbinary:
        return {"reason": "Для системы двух звёзд нужна отдельная модель."}

    if (gravity is not None and gravity < 3.6) or re.search(
        r"(?<![A-Z])(?:III|IV|II|I[ab]?)\b",
        spectral_type or "",
    ):
        return {"reason": "Модель рассчитана для звёзд главной последовательности."}

    if (
        temperature is None
        or luminosity is None
        or not math.isfinite(temperature)
        or not math.isfinite(luminosity)
        or luminosity <= 0
    ):
        return {"reason": "Недостаточно данных о звезде."}

    if not 2000 <= temperature <= 7200:
        return {"reason": "Температура звезды за пределами модели (2 000–7 200 К)."}

    # Haqq-Misra, Wolf & Kopparapu (2026), ExoColumn.
    offset = temperature - 5780

    coefficients = {
        "runaway": (
            1.0684, 9.1544e-5, 1.6309e-8,
            1.7962e-12, 1.2497e-16,
        ),
        "moist_greenhouse": (
            1.0636, 8.7628e-5, 5.7056e-9,
            -3.2355e-12, -5.3193e-16,
        ),
        "maximum_greenhouse": (
            0.3851, 7.1906e-5, 3.2723e-9,
            -3.2530e-12, -5.4811e-16,
        ),
    }

    boundaries = {}

    for name, values in coefficients.items():
        effective_flux = sum(
            coefficient * offset ** power
            for power, coefficient in enumerate(values)
        )

        if effective_flux <= 0 or not math.isfinite(effective_flux):
            return {"reason": "Модель не дала физически допустимую границу."}

        boundaries[name] = math.sqrt(luminosity / effective_flux)

    return {
        **boundaries,
        "inner": boundaries["moist_greenhouse"],
        "outer": boundaries["maximum_greenhouse"],
    }


def orbit_summary(axis, eccentricity, zone):
    result = {"axis": axis, "eccentricity": eccentricity, "near": None, "far": None, "fraction": None}
    if axis is None or axis <= 0 or eccentricity is None or not 0 <= eccentricity < 1:
        return result
    near = axis * (1 - eccentricity)
    far = axis * (1 + eccentricity)
    result.update(near=near, far=far)
    if "inner" not in zone:
        return result

    inner, outer = zone["inner"], zone["outer"]
    if eccentricity == 0:
        fraction = float(inner <= axis <= outer)
    else:
        # Mean anomaly grows linearly in time. The outward half-orbit is symmetric.
        def time_inside(distance):
            if distance <= near:
                return 0
            if distance >= far:
                return 1
            anomaly = math.acos(max(-1, min(1, (1 - distance / axis) / eccentricity)))
            return (anomaly - eccentricity * math.sin(anomaly)) / math.pi

        fraction = time_inside(outer) - time_inside(inner)
    result["fraction"] = fraction
    return result


def habitability_heuristic(metrics, zone, orbit, giant):
    radius = central(metrics["radius"])
    if radius is None or not 0 < radius < 2.5 or giant or "inner" not in zone:
        return None
    distance = orbit["axis"]
    basis = "axis"
    if not distance or distance <= 0:
        luminosity = central(metrics["star_luminosity"])
        flux = central(metrics["flux"])
        if not luminosity or not flux or flux <= 0:
            return None
        distance = math.sqrt(luminosity / flux)
        basis = "flux"

    # The zone gets most of the weight. Close passes just outside its edges
    # retain a small score so that the boundaries of the model aren't absolute.
    inner, outer = zone["inner"], zone["outer"]
    fraction = orbit["fraction"]
    distance_ratio = max(inner / distance, distance / outer, 1)
    proximity = distance_ratio ** -4
    zone_points = 56 * fraction + 14 * proximity if fraction is not None else 60 * proximity

    # Radius is an indirect indicator. Do not derive density from M sin(i)
    # or from a mass–radius relation.
    size = min(1, max(0, (radius - .35) / .4), (2.5 - radius) / 1.1)
    mass_field = metrics["mass"]
    mass = central(mass_field)
    density = None
    if mass and mass > 0 and mass_field["kind"] == metrics["radius"]["kind"] == "published":
        density = 5.514 * mass / radius ** 3
    density_factor = .85 if density is None else .4 + .6 * min(1, max(0, (density - 1.5) / 2.5))
    surface_points = 30 * size * density_factor
    return {
        "score": zone_points + surface_points, "zone": zone_points, "surface": surface_points,
        "basis": "orbit" if fraction is not None else basis, "density": density,
    }


def planet_metrics(row):
    metrics = {field: metric(row, field) for field in FIELDS}
    circumbinary = row["cb_flag"] == "1"
    axis = central(metrics["axis"])
    if axis and row["discoverymethod"] in {"Microlensing", "Imaging"}:
        # The archive can use this column for projected separation for these methods.
        metrics["axis"] = None
        axis = None
    if (axis is None or axis <= 0) and not circumbinary:
        period = central(metrics["period"])
        star_mass = central(metrics["star_mass"])
        if period and period > 0 and star_mass and star_mass > 0:
            metrics["axis"] = estimate(
                (star_mass * (period / 365.25) ** 2) ** (1 / 3),
                "Расчёт из периода и массы звезды по третьему закону Кеплера",
                None,
            )
            axis = central(metrics["axis"])
    luminosity_log = central(metrics["star_log_luminosity"])
    star_radius = central(metrics["star_radius"])
    star_temperature = central(metrics["star_temperature"])
    if luminosity_log is not None:
        metrics["star_luminosity"] = {**metrics["star_log_luminosity"], "value": 10 ** luminosity_log}
    elif star_radius and star_radius > 0 and star_temperature and star_temperature > 0:
        metrics["star_luminosity"] = estimate(
            star_radius ** 2 * (star_temperature / 5772) ** 4,
            "Расчёт из радиуса и температуры звезды",
            CALCULATIONS,
        )
    else:
        metrics["star_luminosity"] = None
    del metrics["star_log_luminosity"]
    luminosity = central(metrics["star_luminosity"])
    if metrics["flux"] is None and luminosity and axis and axis > 0 and not circumbinary:
        metrics["flux"] = estimate(luminosity / axis ** 2, "Расчёт из светимости и большой полуоси", CALCULATIONS)
    return metrics


def build_catalog(rows, fetched_at):
    if len(rows) < 1000 or len({row.get("pl_name") for row in rows}) != len(rows):
        raise ValueError("NASA вернула неполную таблицу или повторяющиеся записи.")
    if not set(COLUMNS).issubset(rows[0]):
        raise ValueError("Структура таблицы NASA изменилась.")

    systems = defaultdict(list)
    ranking, previous_ranking = [], []
    for row in rows:
        if row["pl_controv_flag"] == "1" or not row["pl_name"] or not row["hostname"]:
            continue
        metrics = planet_metrics(row)

        physical = physical_properties(metrics)
        confidence = data_confidence(metrics)

        similarity = earth_similarity(
            physical["radius"],
            physical["density"],
            physical["escape_velocity"],
            surface_temperature=None,
        )

        confidence = data_confidence(metrics)
        name, host = row["pl_name"], row["hostname"]
        if similarity:
            previous_ranking.append((name, host, similarity["score"]))
        spectral_type = row["st_spectype"] or None
        circumbinary = row["cb_flag"] == "1"
        zone = habitable_zone(
            central(metrics["star_temperature"]), central(metrics["star_luminosity"]),
            circumbinary, spectral_type, number(row, "st_logg"),
        )
        eccentricity = metrics["eccentricity"]
        measured_e = central(eccentricity) if eccentricity and eccentricity["kind"] != "assumption" else None
        axis = None if circumbinary else central(metrics["axis"])
        orbit = orbit_summary(axis, measured_e, zone)
        giant = giant_kind(row, metrics)
        index = habitability_heuristic(metrics, zone, orbit, giant)
        if index:
            ranking.append((name, host, index["score"]))
        systems[host].append((row, metrics, similarity, zone, orbit, giant, index))

    def rank_key(entry):
        return -entry[2], entry[0].casefold()

    ranking.sort(key=rank_key)
    top = [name for name, _, _ in ranking[:TOP_COUNT]]
    ranks = {name: position for position, name in enumerate(top, 1)}
    hosts = {host for _, host, _ in ranking[:TOP_COUNT]}
    # Keep the systems linked from the previous version of the ESI ranking.
    hosts.update(host for _, host, _ in sorted(previous_ranking, key=rank_key)[:TOP_COUNT])
    if any(item[0]["pl_name"] == EXAMPLE for item in systems["55 Cnc"]):
        hosts.add("55 Cnc")
    planets = {}
    for host in sorted(hosts):
        for row, metrics, similarity, zone, orbit, giant, index in systems[host]:
            name = row["pl_name"]
            distance = number(row, "sy_dist")
            planets[name] = {
                "name": name, "host": host, "rank": ranks.get(name), "similarity": similarity, "habitability": index,
                "distance": distance * LIGHT_YEARS_PER_PC if distance is not None else None,
                "method": DISCOVERY_METHODS.get(row["discoverymethod"], row["discoverymethod"]),
                "year": int(row["disc_year"]) if row["disc_year"] else None,
                "metrics": metrics, "zone": zone, "giant": giant,
                "orbit": orbit,
                "circumbinary": row["cb_flag"] == "1",
                "spectral_type": row["st_spectype"] or None,
                "spectral_source": reference(row["st_spectype_reflink"]),
                "stars": int(row["sy_snum"] or 0),
                "spectra": sum(int(row[column] or 0) for column in ("pl_ntranspec", "pl_nespec", "pl_ndispec")),
                "esi": similarity,
                "physical": physical,
                "data_confidence": confidence,
            }
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
        "archive_url": ARCHIVE + "/overview/" + quote(name, safe=""),
    }


def distance_chart(planet, siblings):
    zone = planet["zone"]
    entries = [(item, item["orbit"]) for item in siblings if item["orbit"]["axis"] and item["orbit"]["axis"] > 0]
    if not entries and "outer" not in zone:
        return None
    edges = [zone["inner"], zone["outer"]] if "outer" in zone else []
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


def fetch_catalog():
    query = "select " + ",".join(COLUMNS) + " from pscomppars"
    url = ARCHIVE + "/TAP/sync?" + urlencode({"query": query, "format": "csv", "maxrec": 30000})
    request = Request(url, headers={"User-Agent": "KeplerSpace/1.0"})
    with urlopen(request, timeout=20) as response:
        payload = response.read(25_000_001)
    if len(payload) > 25_000_000:
        raise ValueError("Выгрузка NASA превысила ожидаемый размер.")
    return build_catalog(read_csv(payload), datetime.now(timezone.utc))


def save_catalog(catalog, path=LOCAL):
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
        catalog = build_catalog(read_csv(args.csv.read_bytes()), fetched_at)
    else:
        catalog = fetch_catalog()
    save_catalog(catalog, args.output)
    print(f"NASA: {catalog['archive_count']} / Ranked: {catalog['eligible_count']} / Top: {len(catalog['ranking'])}")


if __name__ == "__main__":
    main()