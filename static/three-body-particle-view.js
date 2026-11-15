import * as THREE from "three";
import { fragmentRadius, MAX_PARTICLES, TAIL_POINTS } from "./three-body-particles.js";

export function createParticleView(scene, colors) {
    const geometry = new THREE.IcosahedronGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.InstancedMesh(geometry, material, MAX_PARTICLES);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(mesh);

    const settled = new THREE.Mesh(
        new THREE.SphereGeometry(1, 32, 24),
        new THREE.MeshStandardMaterial({ roughness: 0.64 })
    );
    settled.visible = false;
    scene.add(settled);

    const vertexCount = MAX_PARTICLES * (TAIL_POINTS - 1) * 2;
    const positions = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
    const tailColors = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
    const tailsGeometry = new THREE.BufferGeometry();
    tailsGeometry.setAttribute("position", positions.setUsage(THREE.DynamicDrawUsage));
    tailsGeometry.setAttribute("color", tailColors.setUsage(THREE.DynamicDrawUsage));
    const tails = new THREE.LineSegments(tailsGeometry, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.44, depthWrite: false
    }));
    tails.visible = false;
    tails.frustumCulled = false;
    scene.add(tails);

    const transform = new THREE.Matrix4();
    const palette = colors.map(color => new THREE.Color(color));
    const color = new THREE.Color();
    return {
        render({ indices, particles, accretion, finished }) {
            const [first, second] = indices.map(index => palette[index]);
            settled.visible = finished && particles.length === 1;
            mesh.visible = !settled.visible;
            tails.visible = !finished;
            if (settled.visible) {
                const [particle] = particles;
                settled.position.set(particle.x, particle.y, particle.z);
                settled.scale.setScalar(fragmentRadius(particle, 3, accretion));
                settled.material.color.copy(first).lerp(second, particle.mix);
                return;
            }

            let vertex = 0;
            mesh.count = particles.length;
            particles.forEach((particle, i) => {
                const radius = fragmentRadius(particle, 3, accretion);
                transform.makeScale(radius, radius, radius);
                transform.setPosition(particle.x, particle.y, particle.z);
                mesh.setMatrixAt(i, transform);
                color.copy(first).lerp(second, particle.mix);
                mesh.setColorAt(i, color);
                const tail = particle.tail;
                for (let j = 1; j < (tail?.length ?? 0); j++) {
                    for (const k of [j - 1, j]) {
                        const { x, y, z } = tail[k];
                        const fade = (k + 1) / tail.length;
                        positions.setXYZ(vertex, x, y, z);
                        tailColors.setXYZ(vertex++, color.r * fade, color.g * fade, color.b * fade);
                    }
                }
            });
            mesh.instanceMatrix.needsUpdate = true;
            mesh.instanceColor.needsUpdate = true;
            tailsGeometry.setDrawRange(0, vertex);
            positions.needsUpdate = true;
            tailColors.needsUpdate = true;
        },
        hide() {
            mesh.visible = false;
            settled.visible = false;
            tails.visible = false;
        }
    };
}
