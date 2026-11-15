import * as THREE from "three";
import { MAX_PARTICLES, MAX_TRACES, TAIL_POINTS } from "./three-body-particles.js";

function makeDotTexture() {
    const size = 16;
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
            const opacity = Math.max(0, 1 - distance ** 2) ** 1.6;
            pixels.set([255, 255, 255, Math.round(opacity * 255)], 4 * (y * size + x));
        }
    }
    const texture = new THREE.DataTexture(pixels, size, size);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
}

function pointBuffers(count) {
    const position = new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const color = new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", position);
    geometry.setAttribute("color", color);
    return { position, color, geometry };
}

export function createParticleView(scene, colors) {
    const dots = pointBuffers(MAX_PARTICLES);
    const points = new THREE.Points(dots.geometry, new THREE.PointsMaterial({
        size: 0.028, map: makeDotTexture(), vertexColors: true, transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false
    }));
    const traces = pointBuffers(MAX_TRACES * (TAIL_POINTS - 1) * 2);
    const tails = new THREE.LineSegments(traces.geometry, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.26, depthWrite: false
    }));
    const settled = new THREE.Mesh(
        new THREE.SphereGeometry(1, 32, 24),
        new THREE.MeshStandardMaterial({ roughness: 0.64 })
    );
    points.frustumCulled = false;
    tails.frustumCulled = false;
    points.visible = false;
    tails.visible = false;
    settled.visible = false;
    scene.add(points, tails, settled);

    const palette = colors.map(color => new THREE.Color(color));
    return {
        render({ indices, particles, remnant }) {
            const pairColors = indices.map(index => palette[index]);
            points.visible = particles.length > 0;
            tails.visible = points.visible;
            settled.visible = remnant.m > 0;
            if (settled.visible) {
                settled.position.set(remnant.x, remnant.y, remnant.z);
                settled.scale.setScalar(Math.cbrt(remnant.measure));
                settled.material.color.copy(pairColors[0]).lerp(pairColors[1], remnant.mix);
            }
            if (!points.visible) return;

            let vertex = 0;
            particles.forEach((particle, i) => {
                const color = pairColors[particle.group];
                dots.position.setXYZ(i, particle.x, particle.y, particle.z);
                dots.color.setXYZ(i, color.r, color.g, color.b);
                const tail = particle.tail;
                for (let j = 1; j < (tail?.length ?? 0); j++) {
                    for (const k of [j - 1, j]) {
                        const { x, y, z } = tail[k];
                        const fade = (k + 1) / tail.length;
                        traces.position.setXYZ(vertex, x, y, z);
                        traces.color.setXYZ(vertex++, color.r * fade, color.g * fade, color.b * fade);
                    }
                }
            });
            // Отрисовываем только точки и сегменты, записанные в этом кадре.
            dots.geometry.setDrawRange(0, particles.length);
            dots.position.needsUpdate = true;
            dots.color.needsUpdate = true;
            traces.geometry.setDrawRange(0, vertex);
            traces.position.needsUpdate = true;
            traces.color.needsUpdate = true;
        },
        hide() {
            points.visible = false;
            tails.visible = false;
            settled.visible = false;
        }
    };
}
