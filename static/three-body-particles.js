import { bodyRadius } from "./three-body-collision.js";

const DURATION_MS = 5000;
const STEPS = 300;
const CAPTURE_STEP = 228;
const BASE_DURATION_DAYS = 19;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const SURFACE_PAIRS = 48;
const VOLUME_PAIRS = 168;
const BELT_PAIRS = 384;
const TRACE_STRIDE = 19;
const PARTICLES_PER_DISK = 880;
const PARTICLES_PER_SPHERE = 2 * (SURFACE_PAIRS + VOLUME_PAIRS + BELT_PAIRS);

export const MAX_PARTICLES = 2 * PARTICLES_PER_SPHERE;
export const MAX_TRACES = 4 * Math.ceil(PARTICLES_PER_SPHERE / (2 * TRACE_STRIDE));
export const TAIL_POINTS = 8;

function cross([ax, ay, az], [bx, by, bz]) {
    return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function unit(vector, length = Math.hypot(...vector)) {
    return vector.map(component => component / length);
}

// При касательном ударе плоскость вращения задаёт относительное движение ядер.
function encounterFrame(a, b) {
    const delta = [b.x - a.x, b.y - a.y, b.z - a.z];
    const velocity = [b.vx - a.vx, b.vy - a.vy, b.vz - a.vz];
    const separation = Math.hypot(...delta);
    const along = separation ? unit(delta, separation) : [1, 0, 0];
    const normalCandidate = cross(along, velocity);
    const transverseSpeed = Math.hypot(...normalCandidate);
    const glancing = transverseSpeed > 0.05 * Math.hypot(...velocity);
    const reference = Math.abs(along[2]) < 0.95 ? [0, 0, 1] : [0, 1, 0];
    const across = glancing ? unit(cross(normalCandidate, along)) : unit(cross(reference, along));
    return { along, across, normal: cross(along, across), glancing };
}

function seedDebris(core, frame, group, dimensions, gravity) {
    const count = dimensions === 3 ? PARTICLES_PER_SPHERE : PARTICLES_PER_DISK;
    const mass = core.m / count;
    // Для суммы объёмов или площадей достаточно складывать степени радиусов.
    const measure = core.radius ** dimensions / count;
    const { along, across, normal } = frame;
    const spin = frame.glancing || group === 0 ? 1 : -1;
    const particles = [];

    // Часть точек покрывает поверхность, остальные заполняют объём и плоскость пролёта.
    for (let i = 0; i < count / 2; i++) {
        const surface = i < SURFACE_PAIRS;
        const belt = dimensions === 3 && i >= SURFACE_PAIRS + VOLUME_PAIRS;
        const sample = (i + 0.5) * 0.754877666;
        const depth = sample % 1;
        const azimuth = (i + group * 0.37) * GOLDEN_ANGLE;
        const latitude = dimensions === 2 ? 0 : belt ? (depth - 0.5) * 0.15 : depth;
        const horizontal = Math.sqrt(1 - latitude ** 2);
        const cos = Math.cos(azimuth);
        const sin = Math.sin(azimuth);
        const radius = core.radius * (surface ? 1 : depth ** (1 / (belt ? 2 : dimensions)));
        const radial = along.map((component, axis) => (
            horizontal * (component * cos + across[axis] * sin) + normal[axis] * latitude
        ));
        const tangent = along.map((component, axis) => -component * sin + across[axis] * cos);
        // Круговая скорость в смягчённом поле ядра зависит от радиуса орбиты.
        const orbitSpeed = spin * radius * Math.sqrt(
            gravity * core.m / (core.radius * (radius * radius + core.softeningSquared))
        ) * (0.93 + 0.14 * ((i * 0.6180339887) % 1));
        const traced = i % TRACE_STRIDE === 0 && radius > 0.58 * core.radius;
        for (const sign of [-1, 1]) {
            particles.push({
                x: core.x + sign * radius * radial[0],
                y: core.y + sign * radius * radial[1],
                z: core.z + sign * radius * radial[2],
                vx: core.vx + sign * orbitSpeed * tangent[0],
                vy: core.vy + sign * orbitSpeed * tangent[1],
                vz: core.vz + sign * orbitSpeed * tangent[2],
                m: mass, measure, group, tail: traced ? [] : null
            });
        }
    }
    return particles;
}

function move(body, dt) {
    body.x += body.vx * dt;
    body.y += body.vy * dt;
    body.z += body.vz * dt;
}

function kickFrom(body, source, gravityStep, diskField) {
    const dx = source.x - body.x;
    const dy = source.y - body.y;
    const dz = source.z - body.z;
    const r2 = dx * dx + dy * dy + dz * dz + source.softeningSquared;
    // Внутри облака поле логарифмическое, вдали оно убывает как 1/r².
    const softenedDistance = Math.sqrt(r2);
    const falloff = diskField ? Math.max(source.radius, softenedDistance / 1.6) : softenedDistance;
    const factor = gravityStep * source.m / (r2 * falloff);
    body.vx += dx * factor;
    body.vy += dy * factor;
    body.vz += dz * factor;
}

function kickDebris(particle, [first, second, survivor], halfKick) {
    kickFrom(particle, first, halfKick, true);
    kickFrom(particle, second, halfKick, true);
    kickFrom(particle, survivor, halfKick, false);
}

function kickCenters(centers, gravityStep) {
    for (let i = 0; i < centers.length; i++) {
        const a = centers[i];
        for (let j = i + 1; j < centers.length; j++) {
            const b = centers[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dz = b.z - a.z;
            const r2 = dx * dx + dy * dy + dz * dz + a.softeningSquared + b.softeningSquared;
            const factor = gravityStep / (r2 * Math.sqrt(r2));
            a.vx += dx * factor * b.m;
            a.vy += dy * factor * b.m;
            a.vz += dz * factor * b.m;
            b.vx -= dx * factor * a.m;
            b.vy -= dy * factor * a.m;
            b.vz -= dz * factor * a.m;
        }
    }
}

function dampEncounter(a, b, dt) {
    // Трение при сближении ядер рассеивает энергию и сохраняет импульс пары.
    const distance = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const proximity = distance / (1.8 * (a.radius + b.radius));
    const drag = 1 - Math.exp(-0.14 * dt / (1 + proximity ** 2));
    const dragA = drag * b.m / (a.m + b.m);
    const dragB = drag * a.m / (a.m + b.m);
    const dvx = b.vx - a.vx;
    const dvy = b.vy - a.vy;
    const dvz = b.vz - a.vz;
    a.vx += dvx * dragA;
    a.vy += dvy * dragA;
    a.vz += dvz * dragA;
    b.vx -= dvx * dragB;
    b.vy -= dvy * dragB;
    b.vz -= dvz * dragB;
}

function updateRemnant(remnant, a, b) {
    const weight = b.m / (a.m + b.m);
    remnant.x = a.x + (b.x - a.x) * weight;
    remnant.y = a.y + (b.y - a.y) * weight;
    remnant.z = a.z + (b.z - a.z) * weight;
    remnant.vx = a.vx + (b.vx - a.vx) * weight;
    remnant.vy = a.vy + (b.vy - a.vy) * weight;
    remnant.vz = a.vz + (b.vz - a.vz) * weight;
}

function captureDebris(particles, remnant, radius, remaining) {
    const progress = 1 - (remaining - 1) / (STEPS - CAPTURE_STEP);
    const shrink = ((remaining - 1) / remaining) ** 0.8;
    const threshold = radius * (0.42 + 0.58 * progress);

    // В финале обломки оседают в остаток, сохраняя весь объём вещества.
    for (let i = 0; i < particles.length;) {
        const p = particles[i];
        const dx = (p.x - remnant.x) * shrink;
        const dy = (p.y - remnant.y) * shrink;
        const dz = (p.z - remnant.z) * shrink;
        if (dx * dx + dy * dy + dz * dz <= threshold ** 2) {
            remnant.m += p.m;
            remnant.measure += p.measure;
            remnant.mix += (p.group - remnant.mix) * p.m / remnant.m;
            particles[i] = particles.at(-1);
            particles.pop();
        } else {
            p.x = remnant.x + dx;
            p.y = remnant.y + dy;
            p.z = remnant.z + dz;
            i++;
        }
    }
}

function makeCenter(body) {
    const radius = bodyRadius(body.m);
    return { ...body, z: body.z ?? 0, vz: body.vz ?? 0, radius, softeningSquared: (0.27 * radius) ** 2 };
}

export function createParticleImpact(bodies, { first, second }, dimensions, gravity) {
    const indices = [first, second];
    const survivorIndex = bodies.findIndex((_, i) => !indices.includes(i));
    const a = makeCenter(bodies[first]);
    const b = makeCenter(bodies[second]);
    const survivor = makeCenter(bodies[survivorIndex]);
    const centers = [a, b, survivor];
    const remnant = { m: 0, measure: 0, mix: 0 };
    const radius = (a.radius ** dimensions + b.radius ** dimensions) ** (1 / dimensions);
    const sumOfRadii = a.radius + b.radius;
    const mass = a.m + b.m;
    const frame = encounterFrame(a, b);
    updateRemnant(remnant, a, b);
    const speed = Math.hypot(b.vx - a.vx, b.vy - a.vy, b.vz - a.vz);
    const speedLimit = 2.5 * Math.sqrt(gravity * mass / sumOfRadii);
    const velocityScale = Math.min(1, speedLimit / speed);
    for (const core of [a, b]) {
        core.vx = remnant.vx + (core.vx - remnant.vx) * velocityScale;
        core.vy = remnant.vy + (core.vy - remnant.vy) * velocityScale;
        core.vz = remnant.vz + (core.vz - remnant.vz) * velocityScale;
    }

    const scale = Math.min(1.5, Math.sqrt((sumOfRadii / 0.2) ** 3 * 2 / (mass + survivor.m)));
    // Внешний таймер держит пять секунд, шаг модели зависит от масс и размеров.
    const dt = BASE_DURATION_DAYS * scale / STEPS;
    const halfKick = gravity * dt / 2;
    const particles = [
        ...seedDebris(a, frame, 0, dimensions, gravity),
        ...seedDebris(b, frame, 1, dimensions, gravity)
    ];
    let startedAt;
    let steps = 0;
    return {
        indices, survivorIndex, survivor, particles, remnant,
        get finished() { return steps === STEPS; },
        advance(now) {
            startedAt ??= now;
            const target = Math.min(STEPS, Math.floor((now - startedAt) * STEPS / DURATION_MS));
            const days = (target - steps) * dt;
            while (steps < target) {
                // Полушаги ускорения до и после переноса удерживают орбиты.
                for (const particle of particles) {
                    kickDebris(particle, centers, halfKick);
                    move(particle, dt);
                }
                kickCenters(centers, halfKick);
                for (const center of centers) move(center, dt);
                kickCenters(centers, halfKick);
                dampEncounter(a, b, dt);
                for (const particle of particles) {
                    kickDebris(particle, centers, halfKick);
                }
                if (steps >= CAPTURE_STEP) {
                    updateRemnant(remnant, a, b);
                    captureDebris(particles, remnant, radius, STEPS - steps);
                }
                if (++steps % 5 === 0) {
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
