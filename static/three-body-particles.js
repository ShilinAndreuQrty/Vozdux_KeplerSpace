import { bodyRadius } from "./three-body-collision.js";

const DURATION_MS = 5000;
const STEPS = 300;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
export const MAX_PARTICLES = 240;

function fragmentBody(body, dimensions, mix, centerVelocity, velocityScale, kick) {
    const radius = bodyRadius(body.m);
    const surfacePairs = dimensions === 3 ? 22 : 15;
    const interiorPairs = dimensions === 3 ? 38 : 29;
    const m = body.m / (2 * (surfacePairs + interiorPairs));
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
            for (const sign of [-1, 1]) {
                fragments.push({
                    x: body.x + sign * x * distance,
                    y: body.y + sign * y * distance,
                    z: (body.z ?? 0) + sign * z * distance,
                    vx: centerVelocity.vx + (body.vx - centerVelocity.vx) * velocityScale + sign * x * kick,
                    vy: centerVelocity.vy + (body.vy - centerVelocity.vy) * velocityScale + sign * y * kick,
                    vz: centerVelocity.vz + ((body.vz ?? 0) - centerVelocity.vz) * velocityScale + sign * z * kick,
                    m, mix, count: 1, size: radius * (dimensions === 3 ? 0.079 : 0.057)
                });
            }
        }
    }
    return fragments;
}

function mergeNearby(particles, dimensions) {
    for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length;) {
            const b = particles[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dz = b.z - a.z;
            if (dx * dx + dy * dy + dz * dz > (a.size + b.size) ** 2) {
                j++;
                continue;
            }

            // Неупругое слияние сохраняет массу и импульс.
            a.m += b.m;
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
            particles[j] = particles.at(-1);
            particles.pop();
        }
    }
}

function stepParticles(particles, survivor, dimensions, gravityStep, dt, softeningSquared) {
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
    mergeNearby(particles, dimensions);
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
    const relativeSpeed = Math.hypot(a.vx - b.vx, a.vy - b.vy, (a.vz ?? 0) - (b.vz ?? 0));
    const sumOfRadii = bodyRadius(a.m) + bodyRadius(b.m);
    const scale = Math.min(1.5, Math.sqrt((sumOfRadii / 0.2) ** 3 * 2 / (mass + survivor.m)));
    const dt = (dimensions === 2 ? 3 : 4) * scale / STEPS;
    const velocityScale = Math.min(1, 0.16 / relativeSpeed);
    const kick = 0.003 + Math.min(0.007, relativeSpeed * 0.07);
    const particles = [
        ...fragmentBody(a, dimensions, 0, centerVelocity, velocityScale, kick),
        ...fragmentBody(b, dimensions, 1, centerVelocity, velocityScale, kick)
    ];
    let startedAt;
    let steps = 0;
    return {
        indices, survivorIndex, survivor, particles,
        get finished() { return steps === STEPS; },
        advance(now) {
            startedAt ??= now;
            const target = Math.min(STEPS, Math.floor((now - startedAt) * STEPS / DURATION_MS));
            const days = (target - steps) * dt;
            while (steps < target) {
                stepParticles(particles, survivor, dimensions, gravity * dt, dt, (sumOfRadii * 0.28) ** 2);
                steps++;
            }
            return days;
        }
    };
}
