export function bodyRadius(mass) {
    return 0.075 + Math.min(0.055, Math.cbrt(Math.max(mass, 0.001)) * 0.025);
}

function contactFraction(dx, dy, dz, radius, nextDx, nextDy, nextDz) {
    const gap = dx * dx + dy * dy + dz * dz - radius * radius;
    if (gap <= 0) return 0;

    const vx = nextDx - dx;
    const vy = nextDy - dy;
    const vz = nextDz - dz;
    const approach = dx * vx + dy * vy + dz * vz;
    if (approach >= 0) return null;

    // Ищем первый корень |d + v·t|² = (r₁ + r₂)² на отрезке шага.
    const motionSquared = vx * vx + vy * vy + vz * vz;
    const approachSquared = approach * approach;
    const discriminant = approachSquared - motionSquared * gap;
    const rounding = 4 * Number.EPSILON * approachSquared;
    if (discriminant < -rounding) return null;

    const fraction = gap / (Math.sqrt(Math.max(0, discriminant)) - approach);
    return fraction <= 1 ? fraction : null;
}

export function firstContact(bodies, nextBodies = bodies) {
    const radii = bodies.map(body => bodyRadius(body.m));
    let contact = null;

    for (let first = 0; first < bodies.length; first++) {
        const a = bodies[first];
        const nextA = nextBodies[first];
        for (let second = first + 1; second < bodies.length; second++) {
            const b = bodies[second];
            const nextB = nextBodies[second];
            const fraction = contactFraction(
                b.x - a.x, b.y - a.y, b.z - a.z, radii[first] + radii[second],
                nextB.x - nextA.x, nextB.y - nextA.y, nextB.z - nextA.z
            );
            if (fraction === null || (contact && fraction >= contact.fraction)) continue;
            contact = { first, second, fraction };
            if (fraction === 0) return contact;
        }
    }
    return contact;
}
