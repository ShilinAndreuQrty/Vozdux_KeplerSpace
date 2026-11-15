import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { bodyRadius, firstContact, stateAtContact } from "./three-body-collision.js";
import { createParticleImpact } from "./three-body-particles.js";
import { createParticleView } from "./three-body-particle-view.js";
import { clearToast, showToast } from "./three-body-toast.js";

(() => {
    const stage = document.getElementById("tb-canvas");
    if (!stage) return;

    const byId = id => document.getElementById(id);

    // Модель считает в а.е., сутках и массах Солнца.
    const AU_KM = 149597870.7;
    const DAY_S = 86400;
    const G = 2.959122082855911e-4;
    const KM_S_TO_AU_DAY = DAY_S / AU_KM;
    const SQRT_G = Math.sqrt(G);
    const STEP_DAYS = 0.01;
    const EJECTION_DISTANCE = 10;
    const STABILITY_CHECK_DAYS = 500;
    const EJECTION_CONFIRM_DAYS = 20;
    // 20 000 точек соответствуют примерно 200 суткам траектории.
    const TRAIL_MAX = 20000;
    const VECTOR_SCALE = 28;
    const MIN_ARROW_LENGTH = 0.1;
    const DEFAULT_CAMERA_POSITION = [3.8, -5.8, 4.7];
    const COLLISION_CAMERA_POSITION = [0.9, -3.2, 2.0];
    const GRAZING_CAMERA_POSITION = [0.85, -1.6, 2.55];
    const COLORS = [0x8ddcff, 0xffc58e, 0xc7a5ff];

    // Порядок значений в пресете — x, y, z, vx, vy, vz, масса.
    const PRESETS = {
        figure8: [
            [-0.97000436, 0.24308753, 0, 0.466203685, 0.43236573, 0, 1],
            [0.97000436, -0.24308753, 0, 0.466203685, 0.43236573, 0, 1],
            [0, 0, 0, -0.93240737, -0.86473146, 0, 1]
        ],
        triangle: [
            [0, 0, 0, 0, 0, 0, 1],
            [1.2, 0, 0, 0, 0, 0, 1],
            [0.6, 1.0392304845, 0, 0, 0, 0, 1]
        ],
        collision: [
            [-1.1, 0, -0.55, 0.24, 0, 0.12, 1],
            [1.1, 0, 0.55, -0.24, 0, -0.12, 1],
            [0, 2, 0, 0, 0.12, 0, 0.6]
        ],
        grazing: [
            [-0.85, 0, -0.27, 0.34, -0.165, 0.108, 1],
            [0.85, 0, 0.27, -0.34, 0.165, -0.108, 1],
            [0, 2.15, 0, 0, 0.12, 0, 0.6]
        ]
    };

    let bodies = [];
    let initialBodies = [];
    let velocityDrafts = {};
    let pendingChanges = {};
    let trails = [[], [], []];
    let events = [];
    const eventKeys = new Set();
    let selectedIndex = -1;
    let running = false;
    let time = 0;
    let speed = 32;
    let timeAccumulator = 0;
    let lastFrameTime = 0;
    let bodyPointer = null;
    let vectorPointerId = null;
    let blankPointer = null;
    const dragPlane = new THREE.Plane();
    let dragBodyIndex = -1;
    let activePreset = "figure8";
    let ejectionSince = {};
    let maxSeparation = 0;
    let stabilityReported = false;
    let impact = null;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x080e1b);
    const particleView = createParticleView(scene, COLORS);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    camera.up.set(0, 0, 1);
    camera.position.set(...DEFAULT_CAMERA_POSITION);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.domElement.setAttribute("aria-label", "Трёхмерная сцена симуляции трёх тел");
    renderer.domElement.tabIndex = 0;
    stage.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 0.45;
    controls.maxDistance = 80;
    controls.zoomSpeed = 0.9;
    controls.rotateSpeed = 0.65;
    controls.update();

    scene.add(new THREE.AmbientLight(0xc5d9ff, 1.05));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(4, -3, 7);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x739bdc, 0.75);
    fillLight.position.set(-5, 4, 2);
    scene.add(fillLight);

    // Поворачиваем сетку из XZ в плоскость XY.
    const grid = new THREE.GridHelper(20, 40, 0x7890b8, 0x34435f);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.003;
    grid.material.transparent = true;
    grid.material.opacity = 0.42;
    scene.add(grid);
    const axes = new THREE.AxesHelper(1.65);
    scene.add(axes);

    const sphereGeometry = new THREE.SphereGeometry(1, 32, 24);
    const haloGeometry = new THREE.SphereGeometry(1, 24, 18);
    const handleGeometry = new THREE.SphereGeometry(0.045, 16, 12);
    const bodyObjects = [];
    const trailObjects = [];
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    const bodyHitbox = new THREE.Sphere();
    const hitPoint = new THREE.Vector3();
    const tempVector = new THREE.Vector3();
    const planeHit = new THREE.Vector3();

    function makeLabel(index) {
        const element = document.createElement("div");
        element.className = "tb-body-label";
        element.textContent = `Тело ${index + 1}`;
        stage.appendChild(element);
        return element;
    }

    for (let i = 0; i < 3; i++) {
        const material = new THREE.MeshStandardMaterial({
            color: COLORS[i],
            emissive: COLORS[i],
            emissiveIntensity: 0.28,
            metalness: 0.12,
            roughness: 0.3
        });
        const mesh = new THREE.Mesh(sphereGeometry, material);
        scene.add(mesh);

        const halo = new THREE.Mesh(haloGeometry, new THREE.MeshBasicMaterial({
            color: COLORS[i],
            transparent: true,
            opacity: 0.13,
            depthWrite: false
        }));
        scene.add(halo);

        const arrow = new THREE.ArrowHelper(
            new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.35,
            COLORS[i], 0.11, 0.065
        );
        arrow.line.material.transparent = true;
        arrow.line.material.opacity = 0.88;
        arrow.cone.material.transparent = true;
        arrow.cone.material.opacity = 0.95;
        scene.add(arrow);

        const handle = new THREE.Mesh(handleGeometry, new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.95
        }));
        handle.visible = false;
        scene.add(handle);

        const label = makeLabel(i);
        bodyObjects.push({ mesh, halo, arrow, handle, label });

        const positions = new Float32Array(TRAIL_MAX * 3);
        const geometry = new THREE.BufferGeometry();
        const positionAttribute = new THREE.BufferAttribute(positions, 3);
        positionAttribute.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute("position", positionAttribute);
        geometry.setDrawRange(0, 0);
        const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
            color: COLORS[i],
            transparent: true,
            opacity: 0.45
        }));
        line.frustumCulled = false;
        scene.add(line);
        trailObjects.push(line);
    }

    function resize() {
        const width = Math.max(1, stage.clientWidth);
        const height = Math.max(1, stage.clientHeight);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    }

    function setPointerRay(event) {
        const rect = renderer.domElement.getBoundingClientRect();
        pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointerNdc, camera);
    }

    function pointOnDragPlane(event) {
        setPointerRay(event);
        return raycaster.ray.intersectPlane(dragPlane, planeHit) ? planeHit.clone() : null;
    }

    function bodyAtPointer() {
        let index = -1;
        let nearestDistance = Infinity;
        bodies.forEach((body, candidate) => {
            bodyHitbox.center.set(body.x, body.y, body.z);
            bodyHitbox.radius = bodyRadius(body.m);
            if (!raycaster.ray.intersectSphere(bodyHitbox, hitPoint)) return;
            const distance = raycaster.ray.origin.distanceToSquared(hitPoint);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                index = candidate;
            }
        });
        return index;
    }

    function updateTrail(index) {
        const points = trails[index];
        const line = trailObjects[index];
        const attr = line.geometry.attributes.position;
        for (let j = 0; j < points.length; j++) {
            const k = j * 3;
            attr.array[k] = points[j].x;
            attr.array[k + 1] = points[j].y;
            attr.array[k + 2] = points[j].z;
        }
        attr.needsUpdate = true;
        line.geometry.setDrawRange(0, points.length);
        line.geometry.computeBoundingSphere();
    }

    function updateVisuals() {
        bodies.forEach((body, i) => {
            const objects = bodyObjects[i];
            const position = tempVector.set(body.x, body.y, body.z);
            const radius = bodyRadius(body.m);
            const struck = impact !== null && impact.indices.includes(i);
            const selected = selectedIndex === i;
            objects.mesh.position.copy(position);
            objects.mesh.visible = !struck;
            objects.halo.visible = !struck;
            objects.arrow.visible = !struck;
            objects.handle.visible = !struck && selected && !running;
            updateTrail(i);

            if (struck) {
                objects.label.style.display = "none";
                return;
            }

            objects.mesh.scale.setScalar(radius);
            objects.mesh.material.emissiveIntensity = selected ? 0.65 : 0.28;
            objects.halo.position.copy(position);
            objects.halo.scale.setScalar(radius * (selected ? 2.65 : 2.1));
            const labelPosition = new THREE.Vector3(
                body.x + radius * 1.25,
                body.y,
                body.z + radius * 1.2
            ).project(camera);
            const labelVisible = labelPosition.z >= -1 && labelPosition.z <= 1 &&
                labelPosition.x >= -1.15 && labelPosition.x <= 1.15 &&
                labelPosition.y >= -1.15 && labelPosition.y <= 1.15;
            objects.label.style.display = labelVisible ? "block" : "none";
            if (labelVisible) {
                objects.label.style.left = `${(labelPosition.x * 0.5 + 0.5) * stage.clientWidth}px`;
                objects.label.style.top = `${(-labelPosition.y * 0.5 + 0.5) * stage.clientHeight}px`;
            }

            const displayedVelocity = (!running && selected && pendingChanges[i] && velocityDrafts[i])
                ? velocityDrafts[i] : body;
            const velocity = new THREE.Vector3(displayedVelocity.vx, displayedVelocity.vy, displayedVelocity.vz);
            const magnitude = velocity.length();
            if (magnitude > 1e-12) velocity.multiplyScalar(1 / magnitude);
            else velocity.set(1, 0, 0);
            const arrowLength = Math.max(magnitude * VECTOR_SCALE, MIN_ARROW_LENGTH);
            objects.arrow.position.copy(position);
            objects.arrow.setDirection(velocity);
            objects.arrow.setLength(arrowLength, Math.min(0.14, arrowLength * 0.3), Math.min(0.075, arrowLength * 0.16));
            objects.handle.position.copy(position).addScaledVector(velocity, arrowLength);
        });
        byId("tb-time").textContent = formatNumber(time, 2) + " суток";
    }

    function render() {
        updateVisuals();
        renderer.render(scene, camera);
    }

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const formatNumber = (value, digits = 3) => Number(value).toFixed(digits).replace(".", ",");

    function setStatus(message) {
        byId("tb-status").textContent = message;
    }

    function hasPendingChanges() {
        return Object.keys(pendingChanges).length > 0;
    }

    function markCustom() {
        byId("tb-preset").value = "custom";
    }

    function hasTerminalEvent() {
        return events.some(event => event.type === "collision" || event.type === "ejection");
    }

    function updateStartControl() {
        byId("tb-start").disabled = hasPendingChanges() || hasTerminalEvent();
    }

    function markPendingChange() {
        if (selectedIndex < 0) return;
        pendingChanges[selectedIndex] = true;
        if (running) {
            running = false;
            timeAccumulator = 0;
            byId("tb-start").textContent = "Продолжить";
        }
        updateStartControl();
        setStatus("Есть несохранённые изменения. Примени их или нажми «Отмена». ");
    }

    function setVelocity(body, velocityKmS, angleDegrees) {
        const angle = angleDegrees * Math.PI / 180;
        const velocity = velocityKmS * KM_S_TO_AU_DAY;
        body.vx = velocity * Math.cos(angle);
        body.vy = velocity * Math.sin(angle);
    }

    const velocityXY = body => Math.hypot(body.vx, body.vy) / KM_S_TO_AU_DAY;
    const velocityZ = body => body.vz / KM_S_TO_AU_DAY;

    function randomChaos() {
        const bodies = [];
        const minDistance = 0.65;
        for (let i = 0; i < 3; i++) {
            let body;
            let attempts = 0;
            do {
                body = {
                    x: (Math.random() * 2 - 1) * 1.2,
                    y: (Math.random() * 2 - 1) * 1.2,
                    z: (Math.random() * 2 - 1) * 0.9
                };
                attempts++;
            } while (
                bodies.some(other => Math.hypot(
                    body.x - other.x,
                    body.y - other.y,
                    body.z - other.z
                ) < minDistance) && attempts < 100
            );
            bodies.push(body);
        }

        return bodies.map(body => [
            body.x, body.y, body.z,
            (Math.random() * 0.4 - 0.2),
            (Math.random() * 0.4 - 0.2),
            (Math.random() * 0.4 - 0.2),
            1
        ]);
    }

    function preset(name) {
        activePreset = name;
        const source = name === "chaos" ? randomChaos() : PRESETS[name];
        bodies = source.map(entry => ({
            x: entry[0], y: entry[1], z: entry[2],
            vx: entry[3] * SQRT_G,
            vy: entry[4] * SQRT_G,
            vz: entry[5] * SQRT_G,
            m: entry[6]
        }));

        if (name === "triangle") {
            const side = 1.2;
            const totalMass = bodies.reduce((sum, body) => sum + body.m, 0);
            const centerX = bodies.reduce((sum, body) => sum + body.m * body.x, 0) / totalMass;
            const centerY = bodies.reduce((sum, body) => sum + body.m * body.y, 0) / totalMass;
            const angularSpeed = Math.sqrt(G * totalMass / (side ** 3));
            bodies.forEach(body => {
                const x = body.x - centerX;
                const y = body.y - centerY;
                body.x = x;
                body.y = y;
                body.z = 0;
                body.vx = -angularSpeed * y;
                body.vy = angularSpeed * x;
                body.vz = 0;
            });
        }

        // Переходим в систему отсчёта центра масс.
        const totalMass = bodies.reduce((sum, body) => sum + body.m, 0);
        const center = {
            x: bodies.reduce((sum, body) => sum + body.m * body.x, 0) / totalMass,
            y: bodies.reduce((sum, body) => sum + body.m * body.y, 0) / totalMass,
            z: bodies.reduce((sum, body) => sum + body.m * body.z, 0) / totalMass,
            vx: bodies.reduce((sum, body) => sum + body.m * body.vx, 0) / totalMass,
            vy: bodies.reduce((sum, body) => sum + body.m * body.vy, 0) / totalMass,
            vz: bodies.reduce((sum, body) => sum + body.m * body.vz, 0) / totalMass
        };
        bodies.forEach(body => {
            body.x -= center.x;
            body.y -= center.y;
            body.z -= center.z;
            body.vx -= center.vx;
            body.vy -= center.vy;
            body.vz -= center.vz;
        });

        initialBodies = bodies.map(body => ({ ...body }));
        velocityDrafts = {};
        pendingChanges = {};
        selectedIndex = -1;
        controls.target.set(0, 0, 0);
        const cameraPosition = {
            collision: COLLISION_CAMERA_POSITION,
            grazing: GRAZING_CAMERA_POSITION
        }[name] ?? DEFAULT_CAMERA_POSITION;
        camera.position.set(...cameraPosition);
        controls.update();
        updateEditor();
        resetAll();
    }

    function accelerations(state) {
        return state.map((body, i) => {
            let ax = 0, ay = 0, az = 0;
            state.forEach((other, j) => {
                if (i === j) return;
                const dx = other.x - body.x;
                const dy = other.y - body.y;
                const dz = other.z - body.z;
                const r2 = dx * dx + dy * dy + dz * dz;
                if (r2 < 1e-12) return;
                const factor = G * other.m / (r2 * Math.sqrt(r2));
                ax += dx * factor;
                ay += dy * factor;
                az += dz * factor;
            });
            return { ax, ay, az };
        });
    }

    function derivatives(state) {
        const accelerationsByBody = accelerations(state);
        return state.map((body, i) => ({
            x: body.vx, y: body.vy, z: body.vz,
            vx: accelerationsByBody[i].ax, vy: accelerationsByBody[i].ay, vz: accelerationsByBody[i].az
        }));
    }

    function shift(state, derivative, offset) {
        return state.map((body, i) => ({
            ...body,
            x: body.x + derivative[i].x * offset,
            y: body.y + derivative[i].y * offset,
            z: body.z + derivative[i].z * offset,
            vx: body.vx + derivative[i].vx * offset,
            vy: body.vy + derivative[i].vy * offset,
            vz: body.vz + derivative[i].vz * offset
        }));
    }

    function addEvent(type, bodies, message) {
        const key = type + ":" + bodies.slice().sort((a, b) => a - b).join("-");
        if (eventKeys.has(key)) return;
        eventKeys.add(key);
        events.push({ type, bodies, message, time });
        renderEvents();
    }

    function appendTrailPoint(body, index) {
        const trail = trails[index];
        trail.push({ x: body.x, y: body.y, z: body.z });
        if (trail.length > TRAIL_MAX) trail.shift();
    }

    function beginImpact(contact) {
        const { first, second } = contact;
        // После касания время ведёт модель обломков.
        impact = createParticleImpact(bodies, contact, 3, G);
        running = false;
        timeAccumulator = 0;
        blankPointer = null;
        addEvent("collision", impact.indices, `Столкновение тел ${first + 1} и ${second + 1}`);
        clearSelection();
        updateStartControl();
        byId("tb-start").textContent = "Столкновение";
        setStatus("Столкновение · движение обломков");
    }

    function updateImpact(now) {
        if (!impact || impact.finished) return;
        const days = impact.advance(now);
        const { survivorIndex: index, survivor } = impact;
        if (days > 0) {
            time += days;
            bodies[index] = survivor;
            appendTrailPoint(survivor, index);
        }
        particleView.render(impact);
        if (impact.finished) {
            setStatus("Модель остановлена");
            showToast("Модель остановлена после столкновения");
        }
    }

    function detectOrbitalEvents() {
        let ejection = false;
        for (let i = 0; i < bodies.length; i++) {
            if (eventKeys.has("ejection:" + i)) continue;
            const pair = bodies.filter((_, j) => j !== i);
            const first = pair[0], second = pair[1], body = bodies[i];
            const pairMass = first.m + second.m;
            const center = {
                x: (first.m * first.x + second.m * second.x) / pairMass,
                y: (first.m * first.y + second.m * second.y) / pairMass,
                z: (first.m * first.z + second.m * second.z) / pairMass,
                vx: (first.m * first.vx + second.m * second.vx) / pairMass,
                vy: (first.m * first.vy + second.m * second.vy) / pairMass,
                vz: (first.m * first.vz + second.m * second.vz) / pairMass
            };
            const rx = body.x - center.x;
            const ry = body.y - center.y;
            const rz = body.z - center.z;
            const rvx = body.vx - center.vx;
            const rvy = body.vy - center.vy;
            const rvz = body.vz - center.vz;
            const distance = Math.hypot(rx, ry, rz);
            const radial = rx * rvx + ry * rvy + rz * rvz;
            // Для выброса нужна положительная энергия относительно оставшейся пары.
            const energy = 0.5 * (rvx * rvx + rvy * rvy + rvz * rvz)
                - G * pairMass / Math.max(distance, 1e-12);
            const candidate = distance >= EJECTION_DISTANCE && radial > 0 && energy > 0;

            if (candidate) {
                if (ejectionSince[i] === undefined) ejectionSince[i] = time;
                if (time - ejectionSince[i] >= EJECTION_CONFIRM_DAYS) {
                    addEvent("ejection", [i], `Выброс тела ${i + 1}`);
                    ejection = true;
                }
            } else {
                delete ejectionSince[i];
            }
        }

        const distances = [];
        for (let i = 0; i < bodies.length; i++) {
            for (let j = i + 1; j < bodies.length; j++) {
                distances.push(Math.hypot(
                    bodies[i].x - bodies[j].x,
                    bodies[i].y - bodies[j].y,
                    bodies[i].z - bodies[j].z
                ));
            }
        }
        maxSeparation = Math.max(maxSeparation, ...distances);

        if (time >= STABILITY_CHECK_DAYS && !stabilityReported && events.length === 0 && maxSeparation < EJECTION_DISTANCE) {
            stabilityReported = true;
            addEvent("stable", [], "Предварительно устойчивое движение за 500 суток");
        }

        if (ejection) {
            running = false;
            timeAccumulator = 0;
            byId("tb-start").disabled = true;
            byId("tb-start").textContent = "Выброс тела";
            setStatus("Модель остановлена");
            showToast("Модель остановлена: обнаружен выброс тела");
        }
    }

    function renderEvents() {
        const panel = byId("tb-events");
        if (!panel) return;
        if (!events.length) {
            panel.innerHTML = "<strong>События:</strong> пока не обнаружены";
            return;
        }
        panel.innerHTML = "<strong>Обнаруженные события:</strong><ul>" +
            events.map(event => `<li>${event.message} — ${formatNumber(event.time, 2)} суток</li>`).join("") +
            "</ul>";
    }

    function clearEvents() {
        events = [];
        eventKeys.clear();
        ejectionSince = {};
        maxSeparation = 0;
        stabilityReported = false;
        renderEvents();
    }

    function step() {
        // Перекрывающиеся начальные сферы останавливаем до расчёта сил.
        const initialContact = firstContact(bodies);
        if (initialContact) {
            beginImpact(initialContact);
            return;
        }

        // Шаг метода Рунге — Кутты четвёртого порядка.
        const k1 = derivatives(bodies);
        const k2 = derivatives(shift(bodies, k1, STEP_DAYS / 2));
        const k3 = derivatives(shift(bodies, k2, STEP_DAYS / 2));
        const k4 = derivatives(shift(bodies, k3, STEP_DAYS));

        const nextBodies = bodies.map((body, i) => ({
            ...body,
            x: body.x + STEP_DAYS / 6 * (k1[i].x + 2 * k2[i].x + 2 * k3[i].x + k4[i].x),
            y: body.y + STEP_DAYS / 6 * (k1[i].y + 2 * k2[i].y + 2 * k3[i].y + k4[i].y),
            z: body.z + STEP_DAYS / 6 * (k1[i].z + 2 * k2[i].z + 2 * k3[i].z + k4[i].z),
            vx: body.vx + STEP_DAYS / 6 * (k1[i].vx + 2 * k2[i].vx + 2 * k3[i].vx + k4[i].vx),
            vy: body.vy + STEP_DAYS / 6 * (k1[i].vy + 2 * k2[i].vy + 2 * k3[i].vy + k4[i].vy),
            vz: body.vz + STEP_DAYS / 6 * (k1[i].vz + 2 * k2[i].vz + 2 * k3[i].vz + k4[i].vz)
        }));

        const contact = firstContact(bodies, nextBodies);
        bodies = contact ? stateAtContact(bodies, nextBodies, contact.fraction) : nextBodies;
        time += STEP_DAYS * (contact?.fraction ?? 1);
        bodies.forEach(appendTrailPoint);
        if (contact) beginImpact(contact);
        else detectOrbitalEvents();
    }

    // Стрелка показывает черновик скорости до применения параметров.
    function draftFor(index) {
        if (!velocityDrafts[index]) {
            velocityDrafts[index] = {
                vx: bodies[index].vx,
                vy: bodies[index].vy,
                vz: bodies[index].vz
            };
        }
        return velocityDrafts[index];
    }

    function updateEditor() {
        const fields = byId("tb-fields");
        const help = byId("tb-help");
        if (selectedIndex < 0) {
            fields.hidden = true;
            help.hidden = false;
            byId("tb-editor-title").textContent = "Выбери тело";
            render();
            return;
        }

        const body = bodies[selectedIndex];
        const draft = draftFor(selectedIndex);
        fields.hidden = false;
        help.hidden = true;
        byId("tb-editor-title").textContent = "Тело " + (selectedIndex + 1);
        byId("tb-mass").value = body.m;
        byId("tb-mass-range").value = clamp(body.m, 0.0001, 10);
        byId("tb-mass-out").textContent = formatNumber(body.m, 5);
        byId("tb-x").value = body.x.toFixed(5);
        byId("tb-y").value = body.y.toFixed(5);
        byId("tb-z").value = body.z.toFixed(5);
        byId("tb-vel").value = velocityXY(draft).toFixed(3);
        byId("tb-vel-range").value = clamp(velocityXY(draft), 0, 100);
        byId("tb-vel-out").textContent = formatNumber(velocityXY(draft));
        byId("tb-angle").value = (Math.atan2(draft.vy, draft.vx) * 180 / Math.PI).toFixed(2);
        byId("tb-vz").value = velocityZ(draft).toFixed(3);
        render();
    }

    function resetSimulation() {
        running = false;
        time = 0;
        timeAccumulator = 0;
        trails = bodies.map(body => [{ x: body.x, y: body.y, z: body.z }]);
        if (impact) {
            impact = null;
            particleView.hide();
            clearToast();
        }
        clearEvents();
        byId("tb-start").disabled = false;
        byId("tb-start").textContent = "Запустить";
        updateStartControl();
        setStatus("Модель остановлена");
        render();
    }

    function resetAll() {
        bodies = initialBodies.map(body => ({ ...body }));
        velocityDrafts = {};
        pendingChanges = {};
        byId("tb-preset").value = activePreset;
        resetSimulation();
        updateEditor();
    }

    function resetSelected() {
        if (selectedIndex < 0) return;
        bodies[selectedIndex] = { ...initialBodies[selectedIndex] };
        delete velocityDrafts[selectedIndex];
        delete pendingChanges[selectedIndex];
        resetSimulation();
        updateEditor();
    }

    function releaseBodyPointer() {
        const pointerId = bodyPointer?.id ?? vectorPointerId;
        bodyPointer = null;
        vectorPointerId = null;
        dragBodyIndex = -1;
        controls.enabled = true;
        if (pointerId !== null && renderer.domElement.hasPointerCapture(pointerId)) {
            renderer.domElement.releasePointerCapture(pointerId);
        }
    }

    function clearSelection() {
        if (selectedIndex < 0) return;
        const previousIndex = selectedIndex;
        const hadChanges = !!pendingChanges[previousIndex];
        delete velocityDrafts[previousIndex];
        delete pendingChanges[previousIndex];
        updateStartControl();
        selectedIndex = -1;
        releaseBodyPointer();
        updateEditor();
        if (hadChanges) byId("tb-status").textContent = "Неподтверждённые изменения отменены";
    }

    function readParameters() {
        return {
            m: +byId("tb-mass").value,
            x: +byId("tb-x").value,
            y: +byId("tb-y").value,
            z: +byId("tb-z").value,
            v: +byId("tb-vel").value,
            vz: +byId("tb-vz").value,
            a: +byId("tb-angle").value
        };
    }

    function commitSelectedChanges(parameters) {
        if (selectedIndex < 0) return;
        const draft = draftFor(selectedIndex);
        bodies[selectedIndex].m = parameters.m;
        bodies[selectedIndex].x = parameters.x;
        bodies[selectedIndex].y = parameters.y;
        bodies[selectedIndex].z = parameters.z;
        bodies[selectedIndex].vx = draft.vx;
        bodies[selectedIndex].vy = draft.vy;
        bodies[selectedIndex].vz = draft.vz;
        delete velocityDrafts[selectedIndex];
        delete pendingChanges[selectedIndex];
    }

    function applyMass(all) {
        const parameters = readParameters();
        if (!Number.isFinite(parameters.m) || parameters.m <= 0 || parameters.m > 1000) {
            showToast("Масса должна быть больше нуля и не превышать 1000 масс Солнца.");
            return;
        }
        if (selectedIndex >= 0) commitSelectedChanges(parameters);
        markCustom();
        if (all) bodies.forEach(body => body.m = parameters.m);
        setStatus(all ? "Масса применена ко всем телам" : "Масса применена к телу");
        resetSimulation();
        updateEditor();
    }

    function applyVelocity(all) {
        const parameters = readParameters();
        if (!Number.isFinite(parameters.v) || parameters.v < 0 || parameters.v > 10000 || !Number.isFinite(parameters.vz) || Math.abs(parameters.vz) > 10000) {
            showToast("Проверь компоненты скорости. Допустимое значение по каждой оси: от -10000 до 10000 км/с.");
            return;
        }
        if (selectedIndex >= 0) commitSelectedChanges(parameters);
        markCustom();
        if (all) {
            bodies.forEach(body => {
                const angle = Math.atan2(body.vy, body.vx);
                setVelocity(body, parameters.v, angle * 180 / Math.PI);
            });
        } else if (selectedIndex >= 0) {
            setVelocity(bodies[selectedIndex], parameters.v, parameters.a);
            bodies[selectedIndex].vz = parameters.vz * KM_S_TO_AU_DAY;
        }
        setStatus(all ? "Скорость применена ко всем телам" : "Скорость применена к телу");
        resetSimulation();
        updateEditor();
    }

    function updateDraftFromInputs() {
        if (selectedIndex < 0) return;
        const xySpeed = +byId("tb-vel").value;
        const angle = +byId("tb-angle").value;
        const zSpeed = +byId("tb-vz").value;
        if (![xySpeed, angle, zSpeed].every(Number.isFinite)) return;
        const draft = draftFor(selectedIndex);
        setVelocity(draft, xySpeed, angle);
        draft.vz = zSpeed * KM_S_TO_AU_DAY;
        markPendingChange();
        markCustom();
        byId("tb-vel-out").textContent = formatNumber(xySpeed);
        byId("tb-vel-range").value = clamp(xySpeed, 0, 100);
        render();
    }

    // Перетаскивание идёт в плоскости экрана через центр тела.
    renderer.domElement.addEventListener("pointerdown", event => {
        if (event.button !== 0 || impact || bodyPointer || vectorPointerId !== null) return;
        setPointerRay(event);

        if (selectedIndex >= 0 && !running) {
            const handleHit = raycaster.intersectObject(bodyObjects[selectedIndex].handle, false)[0];
            if (handleHit) {
                vectorPointerId = event.pointerId;
                dragBodyIndex = selectedIndex;
                const origin = bodyObjects[selectedIndex].mesh.position;
                dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), origin);
                controls.enabled = false;
                renderer.domElement.setPointerCapture(event.pointerId);
                event.stopImmediatePropagation();
                return;
            }
        }

        const index = bodyAtPointer();
        if (index >= 0) {
            if (selectedIndex >= 0 && selectedIndex !== index) {
                const hadChanges = !!pendingChanges[selectedIndex];
                delete velocityDrafts[selectedIndex];
                delete pendingChanges[selectedIndex];
                updateStartControl();
                if (hadChanges) byId("tb-status").textContent = "Неподтверждённые изменения отменены";
            }
            selectedIndex = index;
            dragBodyIndex = index;
            bodyPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
            const origin = bodyObjects[index].mesh.position;
            dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), origin);
            controls.enabled = false;
            renderer.domElement.setPointerCapture(event.pointerId);
            updateEditor();
            event.stopImmediatePropagation();
            return;
        }

        blankPointer = { x: event.clientX, y: event.clientY, moved: false };
    }, true);

    renderer.domElement.addEventListener("pointermove", event => {
        if (blankPointer && Math.hypot(event.clientX - blankPointer.x, event.clientY - blankPointer.y) > 4) {
            blankPointer.moved = true;
        }

        if (vectorPointerId === event.pointerId && !running) {
            const point = pointOnDragPlane(event);
            if (!point) return;
            const origin = bodyObjects[dragBodyIndex].mesh.position;
            const velocity = point.sub(origin).divideScalar(VECTOR_SCALE);
            const draft = draftFor(dragBodyIndex);
            draft.vx = velocity.x;
            draft.vy = velocity.y;
            draft.vz = velocity.z;
            markPendingChange();
            markCustom();
            updateEditor();
            return;
        }

        if (bodyPointer?.id !== event.pointerId) return;
        const moved = Math.hypot(event.clientX - bodyPointer.x, event.clientY - bodyPointer.y);
        if (moved > 4) bodyPointer.moved = true;
        if (!bodyPointer.moved) return;

        const point = pointOnDragPlane(event);
        if (!point) return;
        const body = bodies[dragBodyIndex];
        body.x = point.x;
        body.y = point.y;
        body.z = point.z;
        trails[dragBodyIndex] = [{ x: body.x, y: body.y, z: body.z }];
        markCustom();
        byId("tb-x").value = body.x.toFixed(5);
        byId("tb-y").value = body.y.toFixed(5);
        byId("tb-z").value = body.z.toFixed(5);
        render();
    });

    function finishPointer(event) {
        if (bodyPointer?.id === event.pointerId || vectorPointerId === event.pointerId) {
            const editingVelocity = vectorPointerId !== null;
            releaseBodyPointer();
            if (editingVelocity) updateEditor();
            else render();
        }
        if (blankPointer) {
            const wasClick = !blankPointer.moved;
            blankPointer = null;
            if (wasClick) clearSelection();
        }
    }

    renderer.domElement.addEventListener("pointerup", finishPointer);
    renderer.domElement.addEventListener("pointercancel", finishPointer);

    byId("tb-mass").oninput = () => {
        byId("tb-mass-range").value = clamp(+byId("tb-mass").value || 0.0001, 0.0001, 10);
        byId("tb-mass-out").textContent = formatNumber(+byId("tb-mass").value || 0, 5);
        markPendingChange();
    };
    byId("tb-mass-range").oninput = event => {
        byId("tb-mass").value = event.target.value;
        byId("tb-mass-out").textContent = formatNumber(+event.target.value, 5);
        markPendingChange();
    };
    ["tb-x", "tb-y", "tb-z"].forEach(id => byId(id).oninput = markPendingChange);
    byId("tb-vel").oninput = updateDraftFromInputs;
    byId("tb-vel-range").oninput = event => {
        byId("tb-vel").value = event.target.value;
        updateDraftFromInputs();
    };
    byId("tb-angle").oninput = updateDraftFromInputs;
    byId("tb-vz").oninput = updateDraftFromInputs;

    byId("tb-apply").onclick = () => {
        if (selectedIndex < 0) return;
        const p = readParameters();
        if (![p.m, p.x, p.y, p.z, p.v, p.vz, p.a].every(Number.isFinite) ||
            p.m <= 0 || p.m > 1000 ||
            Math.abs(p.x) > 10000 || Math.abs(p.y) > 10000 || Math.abs(p.z) > 10000 ||
            p.v < 0 || p.v > 10000 || Math.abs(p.vz) > 10000) {
            showToast("Проверь массу, координаты и компоненты скорости.");
            return;
        }
        commitSelectedChanges(p);
        setVelocity(bodies[selectedIndex], p.v, p.a);
        bodies[selectedIndex].vz = p.vz * KM_S_TO_AU_DAY;
        markCustom();
        setStatus("Параметры тела применены");
        resetSimulation();
        updateEditor();
    };

    byId("tb-cancel").onclick = () => {
        if (selectedIndex < 0) return;
        delete velocityDrafts[selectedIndex];
        delete pendingChanges[selectedIndex];
        updateEditor();
        updateStartControl();
        setStatus("Несохранённые изменения отменены");
    };
    byId("tb-reset-selected").onclick = resetSelected;
    byId("tb-mass-all").onclick = () => applyMass(true);
    byId("tb-velocity-all").onclick = () => applyVelocity(true);
    byId("tb-preset").onchange = event => preset(event.target.value);
    byId("tb-start").onclick = () => {
        if (hasTerminalEvent()) return;
        if (hasPendingChanges()) {
            showToast("Сначала примени параметры или нажми «Отмена».");
            return;
        }
        running = !running;
        byId("tb-start").textContent = running ? "Остановить" : "Продолжить";
        bodyObjects.forEach(object => object.handle.visible = !running);
        setStatus(running ? "Симуляция выполняется" : "Симуляция остановлена");
    };
    byId("tb-reset").onclick = resetAll;
    byId("tb-speed").oninput = event => {
        speed = +event.target.value;
        byId("tb-speed-out").textContent = speed + "×";
    };

    window.addEventListener("keydown", event => {
        if (event.key !== "Escape" || hasTerminalEvent()) return;
        running = false;
        timeAccumulator = 0;
        clearSelection();
        updateStartControl();
        byId("tb-start").textContent = "Продолжить";
        byId("tb-status").textContent = "Симуляция остановлена";
    });

    function frame(now) {
        if (!lastFrameTime) lastFrameTime = now;
        const elapsed = Math.min((now - lastFrameTime) / 1000, 0.05);
        lastFrameTime = now;
        if (running) {
            timeAccumulator += elapsed * speed * 2;
            let iterations = 0;
            while (running && timeAccumulator >= STEP_DAYS && iterations++ < 500) {
                timeAccumulator -= STEP_DAYS;
                step();
            }
        }
        updateImpact(now);
        controls.update();
        render();
        requestAnimationFrame(frame);
    }

    bodies = PRESETS.figure8.map(entry => ({
        x: entry[0], y: entry[1], z: entry[2],
        vx: entry[3] * SQRT_G,
        vy: entry[4] * SQRT_G,
        vz: entry[5] * SQRT_G,
        m: entry[6]
    }));
    initialBodies = bodies.map(body => ({ ...body }));
    byId("tb-preset").value = activePreset;
    resize();
    updateEditor();
    resetSimulation();
    window.addEventListener("resize", resize);
    if ("ResizeObserver" in window) {
        new ResizeObserver(resize).observe(stage);
    }
    requestAnimationFrame(frame);
})();
