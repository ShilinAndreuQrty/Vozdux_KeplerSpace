export const EJECTION_DISTANCE = 10;
const EJECTION_CONFIRM_DAYS = 20;

export function findEjections(bodies, time, since, gravity) {
    const confirmed = [];
    for (const [index, body] of bodies.entries()) {
        const ids = body.indices ?? [index];
        const key = ids.join("-");
        let mass = 0;
        let x = 0, y = 0, z = 0;
        let vx = 0, vy = 0, vz = 0;
        for (const other of bodies) {
            if (other === body) continue;
            mass += other.m;
            x += other.m * other.x;
            y += other.m * other.y;
            z += other.m * (other.z ?? 0);
            vx += other.m * other.vx;
            vy += other.m * other.vy;
            vz += other.m * (other.vz ?? 0);
        }
        // При разлёте пары отмечаем меньший компонент.
        if (!mass || (bodies.length === 2 && (body.m > mass || (body.m === mass && index === 0)))) {
            since.delete(key);
            continue;
        }

        const dx = body.x - x / mass;
        const dy = body.y - y / mass;
        const dz = (body.z ?? 0) - z / mass;
        const dvx = body.vx - vx / mass;
        const dvy = body.vy - vy / mass;
        const dvz = (body.vz ?? 0) - vz / mass;
        const distance = Math.hypot(dx, dy, dz);
        const outward = dx * dvx + dy * dvy + dz * dvz > 0;
        // Для пары учитываем обе массы в относительной орбите.
        const orbitMass = bodies.length === 2 ? mass + body.m : mass;
        const energy = 0.5 * (dvx * dvx + dvy * dvy + dvz * dvz) - gravity * orbitMass / Math.max(distance, 1e-12);
        if (distance >= EJECTION_DISTANCE && outward && energy > 0) {
            if (!since.has(key)) since.set(key, time);
            if (time - since.get(key) >= EJECTION_CONFIRM_DAYS) confirmed.push(ids);
        } else {
            since.delete(key);
        }
    }
    return confirmed;
}
