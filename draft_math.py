"""Planet comparisons and observation priority from normalized archive data."""

import math
import re


EARTH_DENSITY = 5.514
EARTH_ESCAPE_VELOCITY = 11.186
ESI_WEIGHTS = {
    "radius": 0.57,
    "density": 1.07,
    "escape_velocity": 0.70,
    "surface_temperature": 5.58,
}


def finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def positive(value):
    return finite(value) and value > 0


def central(field):
    if not field or field.get("limit"):
        return None
    value = field.get("value")
    return value if finite(value) else None


def published_value(field):
    return central(field) if field and field.get("kind") == "published" else None


def earth_similarity(radius, density, escape_velocity, surface_temperature):
    references = {
        "radius": (radius, 1.0),
        "density": (density, EARTH_DENSITY),
        "escape_velocity": (escape_velocity, EARTH_ESCAPE_VELOCITY),
        "surface_temperature": (surface_temperature, 288.0),
    }
    components = {
        name: (1 - abs(value - reference) / (value + reference)) ** ESI_WEIGHTS[name]
        if positive(value) else None
        for name, (value, reference) in references.items()
    }
    missing = [name for name, value in components.items() if value is None]
    interior = surface = None
    if components["radius"] is not None and components["density"] is not None:
        interior = math.sqrt(components["radius"] * components["density"])
    if components["escape_velocity"] is not None and components["surface_temperature"] is not None:
        surface = math.sqrt(components["escape_velocity"] * components["surface_temperature"])
    return {
        "score": math.sqrt(interior * surface) if not missing else None,
        "interior": interior,
        "surface": surface,
        "components": components,
        "missing": missing,
    }


def habitable_zone(temperature, luminosity, circumbinary=False, spectral_type="", gravity=None):
    if circumbinary:
        return {"available": False, "reason": "Для орбиты вокруг двух звёзд нужна модель с учётом обеих звёзд."}
    if (gravity is not None and gravity < 3.6) or re.search(r"(?<![A-Z])(?:III|IV|II|I[ab]?)\b", spectral_type or ""):
        return {"available": False, "reason": "Модель рассчитана для звёзд главной последовательности."}
    if not positive(temperature) or not positive(luminosity):
        return {"available": False, "reason": "Для расчёта нужны температура и светимость звезды."}
    if not 2000 <= temperature <= 7200:
        return {"available": False, "reason": "Температура звезды за пределами модели (2 000–7 200 К)."}

    # Коэффициенты из таблицы 1 ExoColumn (Haqq-Misra, Wolf и Kopparapu, 2026).
    offset = temperature - 5780
    coefficients = {
        "runaway": (1.0684, 9.1544e-5, 1.6309e-8, 1.7962e-12, 1.2497e-16),
        "inner": (1.0636, 8.7628e-5, 5.7056e-9, -3.2355e-12, -5.3193e-16),
        "outer": (0.3851, 7.1906e-5, 3.2723e-9, -3.2530e-12, -5.4811e-16),
    }
    distances = {}
    for name, terms in coefficients.items():
        flux = sum(coefficient * offset ** power for power, coefficient in enumerate(terms))
        if not positive(flux):
            return {"available": False, "reason": "Некорректная граница зоны обитаемости."}
        distances[name] = math.sqrt(luminosity / flux)
    return {"available": True, **distances}


def orbit_summary(axis, eccentricity, zone):
    axis = axis if positive(axis) else None
    eccentricity = eccentricity if finite(eccentricity) and 0 <= eccentricity < 1 else None
    result = {
        "axis": axis, "eccentricity": eccentricity, "near": None, "far": None,
        "fraction": None, "status": "unknown",
    }
    if axis is None:
        return result
    if eccentricity is None:
        if zone and zone.get("available"):
            result["status"] = "axis_only"
        return result

    near = axis * (1 - eccentricity)
    far = axis * (1 + eccentricity)
    result.update(near=near, far=far)
    if not zone or not zone.get("available"):
        return result

    inner, outer = zone["inner"], zone["outer"]
    if eccentricity == 0:
        fraction = float(inner <= axis <= outer)
    else:
        def time_inside(distance):
            if distance <= near:
                return 0.0
            if distance >= far:
                return 1.0
            # Средняя аномалия растёт линейно со временем. Половины орбиты симметричны.
            cosine = (1 - distance / axis) / eccentricity
            anomaly = math.acos(max(-1, min(1, cosine)))
            return (anomaly - eccentricity * math.sin(anomaly)) / math.pi

        fraction = min(1.0, max(0.0, time_inside(outer) - time_inside(inner)))
    status = "outside" if fraction == 0 else "inside" if fraction == 1 else "crossing"
    result.update(fraction=fraction, status=status)
    return result


def bulk_values(mass, radius):
    return {
        "density": EARTH_DENSITY * mass / radius ** 3,
        "escape_velocity": EARTH_ESCAPE_VELOCITY * math.sqrt(mass / radius),
    }


def measurement_bounds(field):
    value, plus, minus = field["value"], field.get("plus"), field.get("minus")
    if not finite(plus) or not finite(minus):
        return None
    lower, upper = value - abs(minus), value + abs(plus)
    return (lower, upper) if lower > 0 else None


def physical_properties(mass_field, radius_field):
    mass, radius = published_value(mass_field), published_value(radius_field)
    if not positive(mass) or not positive(radius):
        return {}

    values = {name: {"value": value} for name, value in bulk_values(mass, radius).items()}
    mass_bounds, radius_bounds = measurement_bounds(mass_field), measurement_bounds(radius_field)
    if mass_bounds and radius_bounds:
        # Плотность и скорость убегания растут с массой и падают с радиусом.
        lower = bulk_values(mass_bounds[0], radius_bounds[1])
        upper = bulk_values(mass_bounds[1], radius_bounds[0])
        for key, field in values.items():
            field.update(lower=lower[key], upper=upper[key])
    return values


def observation_priority(radius, zone, orbit, giant):
    axis = orbit.get("axis")
    if giant or not positive(radius) or not .35 < radius < 2.5 or not positive(axis) or not zone.get("available"):
        return None

    # Баллы за время в зоне начисляем при известном эксцентриситете.
    distance_ratio = max(zone["inner"] / axis, axis / zone["outer"], 1)
    proximity_points = 30 * distance_ratio ** -4
    fraction = orbit.get("fraction")
    fraction_points = 40 * fraction if fraction is not None else None
    radius_points = 30 * min((radius - .35) / .4, 1, (2.5 - radius) / 1.1)
    score = proximity_points + radius_points
    if fraction_points is not None:
        score += fraction_points
    return {
        "score": score,
        "proximity_points": proximity_points,
        "fraction_points": fraction_points,
        "radius_points": radius_points,
    }


def evaluate_planet(metrics, zone, orbit, giant=False):
    metrics, zone, orbit = metrics or {}, zone or {}, orbit or {}
    radius = central(metrics.get("radius"))
    surface_temperature = central(metrics.get("surface_temperature"))
    physical = physical_properties(metrics.get("mass"), metrics.get("radius"))
    esi = earth_similarity(
        radius, central(physical.get("density")), central(physical.get("escape_velocity")), surface_temperature,
    )
    coverage = {
        "radius": radius,
        "mass": published_value(metrics.get("mass")),
        "axis": orbit.get("axis"),
        "eccentricity": orbit.get("eccentricity"),
        "star_temperature": central(metrics.get("star_temperature")),
        "star_luminosity": central(metrics.get("star_luminosity")),
        "surface_temperature": surface_temperature,
    }
    missing = [
        name for name, value in coverage.items()
        if value is None or (name != "eccentricity" and not positive(value))
    ]
    return {
        "esi": esi,
        "physical_properties": physical,
        "coverage": {"available": len(coverage) - len(missing), "total": len(coverage), "missing": missing},
        "priority": observation_priority(radius, zone, orbit, giant),
    }
