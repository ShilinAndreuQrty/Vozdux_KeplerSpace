import * as THREE from "three";

const RING_AXIS = new THREE.Vector3(0, 0, 1);
const SPARK_COUNT = 24;

export function createImpactFlash(scene) {
    const group = new THREE.Group();
    group.visible = false;
    scene.add(group);

    const glow = new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshBasicMaterial({
            color: 0xffdfae,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        })
    );
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.91, 1, 48),
        new THREE.MeshBasicMaterial({
            color: 0xffca84,
            side: THREE.DoubleSide,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        })
    );

    const positions = new Float32Array(SPARK_COUNT * 3);
    const colors = new THREE.BufferAttribute(new Float32Array(SPARK_COUNT * 3), 3);
    for (let index = 0; index < SPARK_COUNT; index++) {
        const angle = index * 2.399963;
        const radius = 0.8 + (index % 7) * 0.21;
        positions.set([Math.cos(angle) * radius, Math.sin(angle) * radius, (index % 5 - 2) * 0.18], index * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", colors);
    const sparks = new THREE.Points(geometry, new THREE.PointsMaterial({
        size: 0.05,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending
    }));
    group.add(glow, ring, sparks);

    return {
        start(point, normal, radius, firstColor, secondColor) {
            group.position.copy(point);
            group.quaternion.setFromUnitVectors(RING_AXIS, normal);
            group.scale.setScalar(radius);
            const palette = [new THREE.Color(firstColor), new THREE.Color(secondColor), new THREE.Color(0xffd891)];
            for (let index = 0; index < SPARK_COUNT; index++) {
                const { r, g, b } = palette[index % palette.length];
                colors.setXYZ(index, r, g, b);
            }
            colors.needsUpdate = true;
        },
        update(progress) {
            group.visible = progress < 1;
            if (!group.visible) return;

            const remaining = 1 - progress;
            glow.scale.setScalar(0.32 + progress * 0.75);
            glow.material.opacity = 0.8 * remaining ** 4;
            ring.scale.setScalar(0.65 + progress * 2.8);
            ring.material.opacity = 0.84 * remaining ** 2;
            sparks.scale.setScalar(0.2 + 2.5 * (1 - remaining ** 2));
            sparks.material.opacity = 0.94 * remaining;
        },
        hide() {
            group.visible = false;
        }
    };
}
