export function bodyRadius(mass) {
    // Один радиус задаёт видимый размер, область выбора и момент касания.
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
                b.x - a.x, b.y - a.y, (b.z ?? 0) - (a.z ?? 0), radii[first] + radii[second],
                nextB.x - nextA.x, nextB.y - nextA.y, (nextB.z ?? 0) - (nextA.z ?? 0)
            );
            if (fraction === null || (contact && fraction >= contact.fraction)) continue;
            contact = { first, second, fraction };
            if (fraction === 0) return contact;
        }
    }
    return contact;
}

export function stateAtContact(bodies, nextBodies, fraction) {
    // Останавливаем шаг на первом касании и интерполируем скорость.
    return bodies.map((body, index) => {
        const next = nextBodies[index];
        const lerp = (start, end) => start + fraction * (end - start);
        return {
            ...body,
            x: lerp(body.x, next.x), y: lerp(body.y, next.y),
            z: lerp(body.z ?? 0, next.z ?? 0),
            vx: lerp(body.vx, next.vx), vy: lerp(body.vy, next.vy),
            vz: lerp(body.vz ?? 0, next.vz ?? 0)
        };
    });
}
