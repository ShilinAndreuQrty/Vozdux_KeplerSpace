import * as THREE from "three";
import { MAX_PARTICLES } from "./three-body-particles.js";

export function createParticleView(scene, colors) {
    const geometry = new THREE.IcosahedronGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.InstancedMesh(geometry, material, MAX_PARTICLES);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(mesh);

    const transform = new THREE.Matrix4();
    const palette = colors.map(color => new THREE.Color(color));
    const color = new THREE.Color();
    return {
        render({ indices, particles }) {
            const [first, second] = indices.map(index => palette[index]);
            mesh.visible = true;
            mesh.count = particles.length;
            particles.forEach((particle, i) => {
                transform.makeScale(particle.size, particle.size, particle.size);
                transform.setPosition(particle.x, particle.y, particle.z);
                mesh.setMatrixAt(i, transform);
                mesh.setColorAt(i, color.copy(first).lerp(second, particle.mix));
            });
            mesh.instanceMatrix.needsUpdate = true;
            mesh.instanceColor.needsUpdate = true;
        },
        hide() {
            mesh.visible = false;
        }
    };
}
