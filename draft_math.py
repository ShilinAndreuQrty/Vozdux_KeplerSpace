
ESI_WEIGHTS = {
    "radius": 0.57,
    "density": 1.07,
    "escape_velocity": 0.70,
    "surface_temperature": 5.58,
}


def earth_similarity(radius, density, escape_velocity, surface_temperature):
    references = {
        "radius": (radius, 1.0),
        "density": (density, 5.514),
        "escape_velocity": (escape_velocity, 11.186),
        "surface_temperature": (surface_temperature, 288.0),
    }

    components = {}

    for name, (value, reference) in references.items():
        components[name] = (
            (1 - abs(value - reference) / (value + reference))
            ** ESI_WEIGHTS[name]
            if value is not None and value > 0
            else None
        )

    interior = (
        math.sqrt(components["radius"] * components["density"])
        if all(components[k] is not None for k in ("radius", "density"))
        else None
    )

    surface = (
        math.sqrt(components["escape_velocity"] * components["surface_temperature"])
        if all(components[k] is not None for k in ("escape_velocity", "surface_temperature"))
        else None
    )

    return {
        "score": math.sqrt(interior * surface)
        if interior is not None and surface is not None else None,
        "interior": interior,
        "surface": surface,
        "components": components,
        "complete": interior is not None and surface is not None,
    }


def habitable_zone(temperature, luminosity, circumbinary=False, spectral_type="", gravity=None):
    if circumbinary:
        return {"available": False, "reason": "Для двойных звёзд нужна отдельная модель."}

    if (gravity is not None and gravity < 3.6) or re.search(
        r"(?<![A-Z])(?:III|IV|II|I[ab]?)\b", spectral_type or ""
    ):
        return {"available": False, "reason": "Модель рассчитана для звёзд главной последовательности."}

    if temperature is None or luminosity is None or luminosity <= 0:
        return {"available": False, "reason": "Необходимы температура и светимость звезды."}

    if not 2000 <= temperature <= 7200:
        return {"available": False, "reason": "Температура за пределами модели (2000–7200 K)."}

    offset = temperature - 5780

    coefficients = {
        "runaway": (1.0684, 9.1544e-5, 1.6309e-8, 1.7962e-12, 1.2497e-16),
        "moist": (1.0636, 8.7628e-5, 5.7056e-9, -3.2355e-12, -5.3193e-16),
        "maximum": (0.3851, 7.1906e-5, 3.2723e-9, -3.2530e-12, -5.4811e-16),
    }

    boundaries = {}

    for name, values in coefficients.items():
        flux = sum(c * offset**i for i, c in enumerate(values))
        if flux <= 0:
            return {"available": False, "reason": "Некорректный звёздный поток."}
        boundaries[name] = math.sqrt(luminosity / flux)

    return {
        "available": True,
        "inner": boundaries["moist"],
        "outer": boundaries["maximum"],
        **boundaries,
        "model": "ExoColumn 2026",
        "unit": "AU",
    }


def orbit_summary(axis, eccentricity, zone):
    result = {
        "axis": axis,
        "eccentricity": eccentricity,
        "near": None,
        "far": None,
        "fraction": None,
    }

    if axis is None or eccentricity is None or not (
        math.isfinite(axis) and math.isfinite(eccentricity)
        and axis > 0 and 0 <= eccentricity < 1
    ):
        return result

    near = axis * (1 - eccentricity)
    far = axis * (1 + eccentricity)
    result.update(near=near, far=far)

    if not zone or not zone.get("available"):
        return result

    inner, outer = zone["inner"], zone["outer"]

    def time_inside(distance):
        if distance <= near:
            return 0.0
        if distance >= far:
            return 1.0

        anomaly = math.acos(max(-1, min(
            1, (1 - distance / axis) / eccentricity
        )))
        return (anomaly - eccentricity * math.sin(anomaly)) / math.pi

    fraction = (
        float(inner <= axis <= outer)
        if eccentricity == 0
        else time_inside(outer) - time_inside(inner)
    )

    result["fraction"] = max(0.0, min(1.0, fraction))
    return result


def evaluate_planet(metrics, zone, orbit):
    radius_field = metrics.get("radius") or {}
    mass_field = metrics.get("mass") or {}

    radius = central(radius_field)
    mass = central(mass_field)

    published = (
        radius is not None and mass is not None
        and radius > 0 and mass > 0
        and radius_field.get("kind") == "published"
        and mass_field.get("kind") == "published"
    )

    density = 5.514 * mass / radius**3 if published else None
    escape_velocity = 11.186 * math.sqrt(mass / radius) if published else None

    surface_temperature = central(metrics.get("surface_temperature"))

    esi = earth_similarity(
        radius, density, escape_velocity, surface_temperature
    )

    physical = {
        "radius": radius,
        "mass": mass,
        "density": density,
        "escape_velocity": escape_velocity,
        "derived_from_published_measurements": published,
    }

    checks = {
        "radius": radius is not None,
        "mass": mass is not None,
        "density": density is not None,
        "escape_velocity": escape_velocity is not None,
        "surface_temperature": surface_temperature is not None,
        "stellar_temperature": central(metrics.get("star_temperature")) is not None,
        "stellar_luminosity": central(metrics.get("star_luminosity")) is not None,
        "orbital_axis": orbit.get("axis") is not None,
        "eccentricity": orbit.get("eccentricity") is not None,
        "habitable_zone": bool(zone.get("available")),
    }

    available = [key for key, value in checks.items() if value]
    missing = [key for key, value in checks.items() if not value]

    return {
        "esi": esi,
        "habitable_zone": zone,
        "orbit": orbit,
        "physical_properties": physical,
        "data_confidence": {
            "available": available,
            "missing": missing,
            "completeness": len(available) / len(checks),
        },
    }

