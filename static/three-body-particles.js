import { bodyRadius, sweptContact } from "./three-body-collision.js";

const BASE_STEP_DAYS = 19 / 300;
const DEBRIS_STEP_COST = 64 / 60;
const VELOCITY_FIELDS = ["vx", "vy", "vz"];
const STATE_FIELDS = ["x", "y", "z", ...VELOCITY_FIELDS];
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

function seedDebris(core, frame, spin, dimensions, gravity) {
    const count = dimensions === 3 ? PARTICLES_PER_SPHERE : PARTICLES_PER_DISK;
    const mass = core.m / count;
    const group = core.indices[0];
    // Для суммы объёмов или площадей достаточно складывать степени радиусов.
    const measure = core.measure / count;
    const { along, across, normal } = frame;
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
        const radius = core.fieldRadius * (surface ? 1 : depth ** (1 / (belt ? 2 : dimensions)));
        const radial = along.map((component, axis) => (
            horizontal * (component * cos + across[axis] * sin) + normal[axis] * latitude
        ));
        const tangent = along.map((component, axis) => -component * sin + across[axis] * cos);
        // Круговая скорость в смягчённом поле ядра зависит от радиуса орбиты.
        const orbitSpeed = spin * radius * Math.sqrt(
            gravity * core.m / (core.fieldRadius * (radius * radius + core.softeningSquared))
        ) * (0.93 + 0.14 * ((i * 0.6180339887) % 1));
        const traced = i % TRACE_STRIDE === 0 && radius > 0.58 * core.fieldRadius;
        for (const sign of [-1, 1]) {
            particles.push({
                x: core.x + sign * radius * radial[0],
                y: core.y + sign * radius * radial[1],
                z: core.z + sign * radius * radial[2],
                vx: core.vx + sign * orbitSpeed * tangent[0],
                vy: core.vy + sign * orbitSpeed * tangent[1],
                vz: core.vz + sign * orbitSpeed * tangent[2],
                m: mass, measure, group, owner: core, tail: traced ? [] : null
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

function kickFrom(body, source, gravityStep) {
    const dx = source.x - body.x;
    const dy = source.y - body.y;
    const dz = source.z - body.z;
    const r2 = dx * dx + dy * dy + dz * dz + source.softeningSquared;
    // Внутри облака поле логарифмическое, вдали оно убывает как 1/r².
    const softenedDistance = Math.sqrt(r2);
    const falloff = source.radius ? softenedDistance : Math.max(source.fieldRadius, softenedDistance / 1.6);
    const factor = gravityStep * source.m / (r2 * falloff);
    body.vx += dx * factor;
    body.vy += dy * factor;
    body.vz += dz * factor;
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
    const proximity = distance / (1.8 * (a.fieldRadius + b.fieldRadius));
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

function refreshRadii(center, dimensions) {
    // Для удара берём радиус осевшего вещества. Поле учитывает и облако обломков.
    center.radius = center.solidMeasure ** (1 / dimensions);
    center.fieldRadius = Math.max(0.02, center.measure ** (1 / dimensions));
    center.softeningSquared = (0.27 * center.fieldRadius) ** 2;
}

function makeCenter(body, index, disrupted, dimensions) {
    const measure = bodyRadius(body.m) ** dimensions;
    const colorMass = [0, 0, 0];
    if (!disrupted) colorMass[index] = body.m;
    const center = {
        ...body, z: body.z ?? 0, vz: body.vz ?? 0, indices: [index],
        measure, solidMeasure: disrupted ? 0 : measure, colorMass, debrisCount: 0
    };
    refreshRadii(center, dimensions);
    return center;
}

function absorbParticle(target, particle, dimensions) {
    const source = particle.owner;
    let mass = particle.m;
    let measure = particle.measure;
    if (source !== target) {
        if (source.debrisCount === 1 && !source.radius) {
            mass = source.m;
            measure = source.measure;
        }
        const remaining = source.m - mass;
        const share = mass / (target.m + mass);
        // Импульс передаётся телу. Реакцию редеющего облака ограничивает его остаточная масса.
        const recoil = Math.min(1, remaining / (4 * mass));
        for (const key of VELOCITY_FIELDS) {
            const incoming = source[key] + (particle[key] - source[key]) * recoil;
            target[key] += (incoming - target[key]) * share;
            if (remaining > 0) source[key] += (source[key] - incoming) * mass / remaining;
        }
        source.m = remaining;
        source.measure = Math.max(0, source.measure - measure);
        target.m += mass;
        target.measure += measure;
        refreshRadii(source, dimensions);
    }
    source.debrisCount--;
    target.solidMeasure += measure;
    target.colorMass[particle.group] += mass;
    refreshRadii(target, dimensions);
}

function mergeCenters(a, b, centers, particles, dimensions) {
    const weight = b.m / (a.m + b.m);
    for (const key of STATE_FIELDS) a[key] += (b[key] - a[key]) * weight;
    a.m += b.m;
    a.measure += b.measure;
    a.solidMeasure += b.solidMeasure;
    a.debrisCount += b.debrisCount;
    a.indices = [...a.indices, ...b.indices].sort((x, y) => x - y);
    a.colorMass = a.colorMass.map((mass, i) => mass + b.colorMass[i]);
    for (const particle of particles) {
        if (particle.owner === b) particle.owner = a;
    }
    centers.splice(centers.indexOf(b), 1);
    refreshRadii(a, dimensions);
}

function seedRemnant(center, particles, dimensions) {
    const radius = 0.35 * center.fieldRadius;
    let closest = -1;
    let nearest = Infinity;
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        if (p.owner !== center) continue;
        const distance = Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z);
        if (distance <= radius) {
            absorbParticle(center, p, dimensions);
            particles[i] = particles.at(-1);
            particles.pop();
        } else if (distance < nearest) {
            nearest = distance;
            closest = i;
        }
    }
    if (!center.radius && closest >= 0) {
        absorbParticle(center, particles[closest], dimensions);
        particles[closest] = particles.at(-1);
        particles.pop();
    }
}

function canCondense(a, b, gravity) {
    const distance = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const capture = 0.43 * (a.fieldRadius + b.fieldRadius);
    if (distance > capture) return false;
    const softened = a.softeningSquared + b.softeningSquared;
    const strength = gravity * (a.m + b.m);
    const speedSquared = (a.vx - b.vx) ** 2 + (a.vy - b.vy) ** 2 + (a.vz - b.vz) ** 2;
    // Ядра оседают, когда энергии уже не хватает выйти из области захвата.
    const energy = 0.5 * speedSquared - strength / Math.sqrt(distance ** 2 + softened);
    return energy <= -strength / Math.sqrt(capture ** 2 + softened);
}

function dampBoundDebris(particle, dt) {
    const core = particle.owner;
    if (!core.radius) return;
    const distance = Math.hypot(particle.x - core.x, particle.y - core.y, particle.z - core.z);
    const proximity = distance / (3 * core.fieldRadius);
    if (proximity >= 1) return;
    const drag = (1 - Math.exp(-0.30 * dt)) * (1 - proximity ** 2);
    for (const key of VELOCITY_FIELDS) particle[key] += (core[key] - particle[key]) * drag;
}

function advanceParticles(particles, centers, previous, dt, halfKick) {
    const solidIndices = previous.flatMap((body, i) => body.radius ? [i] : []);
    const hits = [];
    const start = {};
    for (const [index, particle] of particles.entries()) {
        start.x = particle.x;
        start.y = particle.y;
        start.z = particle.z;
        for (const center of previous) kickFrom(particle, center, halfKick);
        move(particle, dt);
        for (const center of centers) kickFrom(particle, center, halfKick);
        dampBoundDebris(particle, dt);

        let target = null;
        let earliest = Infinity;
        for (const i of solidIndices) {
            // Проверяем весь отрезок движения точки относительно подвижной сферы.
            const contact = sweptContact(previous[i], start, centers[i], particle, previous[i].radius);
            if (contact !== null && contact < earliest) {
                target = centers[i];
                earliest = contact;
            }
        }
        if (target) hits.push({ index, target });
    }
    return hits;
}

function firstSphereImpact(centers, previous) {
    let impact = null;
    let earliest = Infinity;
    for (let i = 0; i < centers.length; i++) {
        const a = centers[i];
        if (!a.radius) continue;
        for (let j = i + 1; j < centers.length; j++) {
            const b = centers[j];
            if (!b.radius) continue;
            const fraction = sweptContact(previous[i], previous[j], a, b, a.radius + b.radius);
            if (fraction !== null && fraction < earliest) {
                impact = [a, b];
                earliest = fraction;
            }
        }
    }
    return impact;
}

export function createParticleImpact(bodies, { first, second }, dimensions, gravity) {
    const centers = bodies.map((body, i) => makeCenter(body, i, i === first || i === second, dimensions));
    const a = centers[first];
    const b = centers[second];
    const frame = encounterFrame(a, b);
    const sumOfRadii = a.fieldRadius + b.fieldRadius;
    const mass = a.m + b.m;
    const speed = Math.hypot(b.vx - a.vx, b.vy - a.vy, b.vz - a.vz);
    const speedLimit = 2.5 * Math.sqrt(gravity * mass / sumOfRadii);
    const velocityScale = Math.min(1, speedLimit / speed);
    for (const key of VELOCITY_FIELDS) {
        const centerVelocity = a[key] + (b[key] - a[key]) * b.m / mass;
        a[key] = centerVelocity + (a[key] - centerVelocity) * velocityScale;
        b[key] = centerVelocity + (b[key] - centerVelocity) * velocityScale;
    }

    const scale = Math.min(1.5, Math.sqrt((sumOfRadii / 0.2) ** 3 * 2 / centers.reduce((sum, body) => sum + body.m, 0)));
    const stepDays = BASE_STEP_DAYS * scale;
    const halfKick = gravity * stepDays / 2;
    const firstCloud = seedDebris(a, frame, 1, dimensions, gravity);
    const secondCloud = seedDebris(b, frame, frame.glancing ? 1 : -1, dimensions, gravity);
    a.debrisCount = firstCloud.length;
    b.debrisCount = secondCloud.length;
    const particles = [...firstCloud, ...secondCloud];
    let steps = 0;

    return {
        centers, particles, stepDays,
        // Обломки замедляют ход модели для наглядности. Ползунок скорости продолжает работать.
        get stepCost() { return particles.length ? DEBRIS_STEP_COST : stepDays; },
        step() {
            const previous = centers.map(center => ({ ...center }));
            kickCenters(centers, halfKick);
            for (const center of centers) move(center, stepDays);
            kickCenters(centers, halfKick);

            const hits = advanceParticles(particles, centers, previous, stepDays, halfKick);
            const debrisHits = new Set();
            for (const { index, target } of hits.reverse()) {
                const particle = particles[index];
                if (particle.owner !== target) debrisHits.add(target.indices);
                absorbParticle(target, particle, dimensions);
                particles[index] = particles.at(-1);
                particles.pop();
            }

            const events = [...debrisHits].map(indices => ({ type: "debris", indices }));
            const sphereImpact = firstSphereImpact(centers, previous);
            if (sphereImpact) {
                const [left, right] = sphereImpact;
                mergeCenters(left, right, centers, particles, dimensions);
                events.push({ type: "collision", indices: left.indices });
            }
            for (let i = centers.length - 1; i >= 0; i--) {
                if (centers[i].m === 0) centers.splice(i, 1);
            }

            const diffuse = centers.filter(center => !center.radius);
            if (diffuse.length === 2) {
                const [left, right] = diffuse;
                dampEncounter(left, right, stepDays);
                if (canCondense(left, right, gravity)) {
                    mergeCenters(left, right, centers, particles, dimensions);
                    seedRemnant(left, particles, dimensions);
                }
            } else if (diffuse.length === 1) {
                seedRemnant(diffuse[0], particles, dimensions);
            }

            if (++steps % 5 === 0) {
                for (const p of particles) {
                    if (!p.tail) continue;
                    p.tail.push({ x: p.x, y: p.y, z: p.z });
                    if (p.tail.length > TAIL_POINTS) p.tail.shift();
                }
            }
            return events;
        }
    };
}
