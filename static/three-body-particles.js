import { bodyRadius } from "./three-body-collision.js";

const DURATION_MS = 5000;
const STEPS = 300;
const ACCRETION_START = 204;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
export const MAX_PARTICLES = 240;
export const TAIL_POINTS = 8;

function fragmentBody(body, dimensions, mix, centerVelocity, velocityScale, kick, spin) {
    const radius = bodyRadius(body.m);
    const surfacePairs = dimensions === 3 ? 22 : 15;
    const interiorPairs = dimensions === 3 ? 38 : 29;
    const count = 2 * (surfacePairs + interiorPairs);
    const m = body.m / count;
    const measure = radius ** dimensions / count;
    const [wx, wy, wz] = spin;
    const fragments = [];

    // Противоположные точки сохраняют центр масс и суммарный импульс.
    for (const [pairs, surface] of [[surfacePairs, true], [interiorPairs, false]]) {
        for (let i = 0; i < pairs; i++) {
            const angle = dimensions === 2 && surface ? Math.PI * i / pairs : i * GOLDEN_ANGLE;
            const z = dimensions === 3 ? (i + 0.5) / pairs : 0;
            const xy = Math.sqrt(1 - z * z);
            const x = Math.cos(angle) * xy;
            const y = Math.sin(angle) * xy;
            const depth = (((i * 17) % pairs) + 0.5) / pairs;
            const distance = surface ? radius : radius * depth ** (1 / dimensions);
            // На краю касательная скорость выше, чем у центра.
            const outward = kick * (distance / radius);
            const vx = (wy * z - wz * y) * distance + x * outward;
            const vy = (wz * x - wx * z) * distance + y * outward;
            const vz = (wx * y - wy * x) * distance + z * outward;
            for (const sign of [-1, 1]) {
                fragments.push({
                    x: body.x + sign * x * distance,
                    y: body.y + sign * y * distance,
                    z: (body.z ?? 0) + sign * z * distance,
                    vx: centerVelocity.vx + (body.vx - centerVelocity.vx) * velocityScale + sign * vx,
                    vy: centerVelocity.vy + (body.vy - centerVelocity.vy) * velocityScale + sign * vy,
                    vz: centerVelocity.vz + ((body.vz ?? 0) - centerVelocity.vz) * velocityScale + sign * vz,
                    m, mix, measure, count: 1,
                    size: radius * (dimensions === 3 ? 0.079 : 0.057),
                    tail: surface ? [] : null
                });
            }
        }
    }
    return fragments;
}

export function fragmentRadius(particle, dimensions, accretion) {
    const fullRadius = particle.measure ** (1 / dimensions);
    return particle.size + (fullRadius - particle.size) * accretion;
}

function mergeNearby(particles, dimensions, accretion) {
    for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length;) {
            const b = particles[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dz = b.z - a.z;
            const captureRadius = (a.size + b.size) * (0.6 + 0.4 * accretion);
            if (dx * dx + dy * dy + dz * dz > captureRadius ** 2) {
                j++;
                continue;
            }

            // Размер точек отделён от объёма вещества (площади в 2D).
            a.m += b.m;
            a.measure += b.measure;
            const weight = b.m / a.m;
            a.x += dx * weight;
            a.y += dy * weight;
            a.z += dz * weight;
            a.vx += (b.vx - a.vx) * weight;
            a.vy += (b.vy - a.vy) * weight;
            a.vz += (b.vz - a.vz) * weight;
            a.mix += (b.mix - a.mix) * weight;
            a.count += b.count;
            a.size = (a.size ** dimensions + b.size ** dimensions) ** (1 / dimensions);
            if (a.count > 6) a.tail = null;
            particles[j] = particles.at(-1);
            particles.pop();
        }
    }
}

function stepParticles(particles, survivor, gravityStep, dt, softeningSquared) {
    const objects = [...particles, survivor];
    for (let i = 0; i < objects.length; i++) {
        const a = objects[i];
        for (let j = i + 1; j < objects.length; j++) {
            const b = objects[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dz = b.z - a.z;
            const r2 = dx * dx + dy * dy + dz * dz + softeningSquared;
            const force = gravityStep / (r2 * Math.sqrt(r2));
            const pullA = force * b.m;
            const pullB = force * a.m;
            a.vx += dx * pullA;
            a.vy += dy * pullA;
            a.vz += dz * pullA;
            b.vx -= dx * pullB;
            b.vy -= dy * pullB;
            b.vz -= dz * pullB;
        }
    }
    for (const body of objects) {
        body.x += body.vx * dt;
        body.y += body.vy * dt;
        body.z += body.vz * dt;
    }
}

function contractCloud(particles, factor) {
    let mass = 0;
    let x = 0, y = 0, z = 0;
    for (const p of particles) {
        mass += p.m;
        x += p.x * p.m;
        y += p.y * p.m;
        z += p.z * p.m;
    }
    x /= mass;
    y /= mass;
    z /= mass;
    for (const p of particles) {
        p.x = x + (p.x - x) * factor;
        p.y = y + (p.y - y) * factor;
        p.z = z + (p.z - z) * factor;
    }
}

function impactAxis(a, b, relativeVelocity, relativeSpeed) {
    const x = b.x - a.x;
    const y = b.y - a.y;
    const z = (b.z ?? 0) - (a.z ?? 0);
    const [vx, vy, vz] = relativeVelocity;
    const axis = [y * vz - z * vy, z * vx - x * vz, x * vy - y * vx];
    const length = Math.hypot(...axis);
    if (length > 0.12 * Math.hypot(x, y, z) * relativeSpeed) {
        return axis.map(component => component / length);
    }
    // При лобовом ударе создаём встречное вращение вокруг поперечной оси.
    const lateral = Math.hypot(x, y);
    const distance = Math.hypot(lateral, z);
    if (!distance) return [0, 0, 1];
    if (lateral < 0.05 * distance) return [0, 1, 0];
    return [-x * z / (distance * lateral), -y * z / (distance * lateral), lateral / distance];
}

export function createParticleImpact(bodies, { first, second }, dimensions, gravity) {
    const indices = [first, second];
    const survivorIndex = bodies.findIndex((_, i) => !indices.includes(i));
    const body = bodies[survivorIndex];
    const survivor = { ...body, z: body.z ?? 0, vz: body.vz ?? 0 };
    const a = bodies[first];
    const b = bodies[second];
    const mass = a.m + b.m;
    const centerVelocity = {
        vx: (a.vx * a.m + b.vx * b.m) / mass,
        vy: (a.vy * a.m + b.vy * b.m) / mass,
        vz: ((a.vz ?? 0) * a.m + (b.vz ?? 0) * b.m) / mass
    };
    const relativeVelocity = [b.vx - a.vx, b.vy - a.vy, (b.vz ?? 0) - (a.vz ?? 0)];
    const relativeSpeed = Math.hypot(...relativeVelocity);
    const radiusA = bodyRadius(a.m);
    const radiusB = bodyRadius(b.m);
    const sumOfRadii = radiusA + radiusB;
    const scale = Math.min(1.5, Math.sqrt((sumOfRadii / 0.2) ** 3 * 2 / (mass + survivor.m)));
    const dt = (dimensions === 2 ? 3 : 4) * scale / STEPS;
    const velocityScale = Math.min(1, 0.16 / relativeSpeed);
    const kick = 0.003 + Math.min(0.007, relativeSpeed * 0.07);
    const axis = impactAxis(a, b, relativeVelocity, relativeSpeed);
    const spin = Math.min(0.14, 0.035 + 0.55 * relativeSpeed) / (sumOfRadii / 2);
    const inertiaA = a.m * radiusA ** 2;
    const inertiaB = b.m * radiusB ** 2;
    const particles = [
        ...fragmentBody(a, dimensions, 0, centerVelocity, velocityScale, kick,
            axis.map(component => component * spin * Math.min(1, inertiaB / inertiaA))),
        ...fragmentBody(b, dimensions, 1, centerVelocity, velocityScale, kick,
            axis.map(component => -component * spin * Math.min(1, inertiaA / inertiaB)))
    ];
    let startedAt;
    let steps = 0;
    let accretion = 0;
    return {
        indices, survivorIndex, survivor, particles,
        get accretion() { return accretion; },
        get finished() { return steps === STEPS; },
        advance(now) {
            startedAt ??= now;
            const target = Math.min(STEPS, Math.floor((now - startedAt) * STEPS / DURATION_MS));
            const days = (target - steps) * dt;
            while (steps < target) {
                stepParticles(particles, survivor, gravity * dt, dt, (sumOfRadii * 0.28) ** 2);
                // В финале стягиваем остатки к центру масс без потери вещества.
                if (steps >= ACCRETION_START) {
                    contractCloud(particles, ((STEPS - steps - 1) / (STEPS - steps)) ** 0.85);
                    accretion = (steps + 1 - ACCRETION_START) / (STEPS - ACCRETION_START);
                }
                mergeNearby(particles, dimensions, accretion);
                steps++;
                if (steps % 5 === 0) {
                    for (const p of particles) {
                        if (!p.tail) continue;
                        p.tail.push({ x: p.x, y: p.y, z: p.z });
                        if (p.tail.length > TAIL_POINTS) p.tail.shift();
                    }
                }
            }
            return days;
        }
    };
}
