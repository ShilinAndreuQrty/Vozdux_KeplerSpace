import { showToast } from "./three-body-toast.js";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

(() => {
    const stage = document.getElementById("tb-canvas");
    if (!stage) return;

    const $ = id => document.getElementById(id);
    const AU_KM = 149597870.7;
    const DAY_S = 86400;
    const G = 2.959122082855911e-4;
    const KM_S_TO_AU_DAY = DAY_S / AU_KM;
    const SQRT_G = Math.sqrt(G);
    const DT = 0.01;
    const COLLISION_DISTANCE = 0.01;
    const EJECTION_DISTANCE = 10;
    const STABILITY_CHECK_DAYS = 500;
    const EJECTION_CONFIRM_DAYS = 20;
    // Храним до 20 000 точек: при DT = 0.01 это примерно 200 суток траектории.
    const TRAIL_MAX = 20000;
    const VECTOR_SCALE = 28;
    const MIN_ARROW_LENGTH = 0.1;
    const COLORS = [0x8ddcff, 0xffc58e, 0xc7a5ff];
    const COLOR_CSS = ["#8ddcff", "#ffc58e", "#c7a5ff"];

    // Каждый пресет хранит [x, y, z, vx, vy, vz, m].
    // Для плоских точных решений z = 0 и vz = 0.
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
        ]
    };

    let B = [];
    let INITIAL = [];
    let DRAFT = {};
    let DIRTY = {};
    let T = [[], [], []];
    let EVENTS = [];
    const EVENT_KEYS = new Set();
    let sel = -1;
    let run = false;
    let time = 0;
    let speed = 32;
    let acc = 0;
    let last = 0;
    let bodyPointer = null;
    let vectorPointer = false;
    let blankPointer = null;
    let dragPlane = new THREE.Plane();
    let dragBodyIndex = -1;
    let activePreset = "figure8";
    let ejectionSince = {};
    let maxSeparation = 0;
    let stabilityReported = false;

    // ---------- Three.js: сцена, камера, рендерер и управление камерой ----------
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x080e1b);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    camera.up.set(0, 0, 1);
    camera.position.set(3.8, -5.8, 4.7);

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

    // GridHelper изначально лежит в XZ; поворачиваем его в физическую плоскость XY.
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
        mesh.userData.bodyIndex = i;
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
        scene.add(label);
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

    function updateTrail(index) {
        const points = T[index];
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
        B.forEach((body, i) => {
            const objects = bodyObjects[i];
            const position = tempVector.set(body.x, body.y, body.z);
            const radius = 0.075 + Math.min(0.055, Math.cbrt(Math.max(body.m, 0.001)) * 0.025);
            objects.mesh.position.copy(position);
            objects.mesh.scale.setScalar(radius);
            objects.mesh.material.emissiveIntensity = sel === i ? 0.65 : 0.28;
            objects.halo.position.copy(position);
            objects.halo.scale.setScalar(radius * (sel === i ? 2.65 : 2.1));
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

            const displayedVelocity = (!run && sel === i && DIRTY[i] && DRAFT[i]) ? DRAFT[i] : body;
            const velocity = new THREE.Vector3(displayedVelocity.vx, displayedVelocity.vy, displayedVelocity.vz);
            const magnitude = velocity.length();
            if (magnitude > 1e-12) velocity.multiplyScalar(1 / magnitude);
            else velocity.set(1, 0, 0);
            const arrowLength = Math.max(magnitude * VECTOR_SCALE, MIN_ARROW_LENGTH);
            objects.arrow.position.copy(position);
            objects.arrow.setDirection(velocity);
            objects.arrow.setLength(arrowLength, Math.min(0.14, arrowLength * 0.3), Math.min(0.075, arrowLength * 0.16));
            objects.handle.position.copy(position).addScaledVector(velocity, arrowLength);
            objects.handle.visible = sel === i && !run;
            updateTrail(i);
        });
        $("tb-time").textContent = fmt(time, 2) + " суток";
    }

    function render() {
        updateVisuals();
        renderer.render(scene, camera);
    }

    // ---------- Физическая модель в трёх измерениях ----------
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    const fmt = (x, n = 3) => Number(x).toFixed(n).replace(".", ",");

    function setStatus(message) {
        $("tb-status").textContent = message;
    }

    function hasPendingChanges() {
        return Object.keys(DIRTY).length > 0;
    }

    function markCustom() {
        $("tb-preset").value = "custom";
    }

    function updateStartControl() {
        const eventStop = EVENTS.some(e => e.type === "collision" || e.type === "ejection");
        $("tb-start").disabled = hasPendingChanges() || eventStop;
    }

    function markPendingChange() {
        if (sel < 0) return;
        DIRTY[sel] = true;
        if (run) {
            run = false;
            acc = 0;
            $("tb-start").textContent = "Продолжить";
        }
        updateStartControl();
        setStatus("Есть несохранённые изменения. Примени их или нажми «Отмена». ");
    }

    function setV(body, velocityKmS, angleDegrees) {
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
        B = source.map(a => ({
            x: a[0], y: a[1], z: a[2],
            vx: a[3] * SQRT_G,
            vy: a[4] * SQRT_G,
            vz: a[5] * SQRT_G,
            m: a[6]
        }));

        if (name === "triangle") {
            const side = 1.2;
            const totalMass = B.reduce((sum, body) => sum + body.m, 0);
            const cx = B.reduce((sum, body) => sum + body.m * body.x, 0) / totalMass;
            const cy = B.reduce((sum, body) => sum + body.m * body.y, 0) / totalMass;
            const w = Math.sqrt(G * totalMass / (side ** 3));
            B.forEach(body => {
                const x = body.x - cx;
                const y = body.y - cy;
                body.x = x;
                body.y = y;
                body.z = 0;
                body.vx = -w * y;
                body.vy = w * x;
                body.vz = 0;
            });
        }

        const totalMass = B.reduce((sum, body) => sum + body.m, 0);
        const center = {
            x: B.reduce((sum, body) => sum + body.m * body.x, 0) / totalMass,
            y: B.reduce((sum, body) => sum + body.m * body.y, 0) / totalMass,
            z: B.reduce((sum, body) => sum + body.m * body.z, 0) / totalMass,
            vx: B.reduce((sum, body) => sum + body.m * body.vx, 0) / totalMass,
            vy: B.reduce((sum, body) => sum + body.m * body.vy, 0) / totalMass,
            vz: B.reduce((sum, body) => sum + body.m * body.vz, 0) / totalMass
        };
        B.forEach(body => {
            body.x -= center.x;
            body.y -= center.y;
            body.z -= center.z;
            body.vx -= center.vx;
            body.vy -= center.vy;
            body.vz -= center.vz;
        });

        INITIAL = B.map(body => ({ ...body }));
        DRAFT = {};
        DIRTY = {};
        sel = -1;
        controls.target.set(0, 0, 0);
        camera.position.set(3.8, -5.8, 4.7);
        controls.update();
        editor();
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
        const a = accelerations(state);
        return state.map((body, i) => ({
            x: body.vx, y: body.vy, z: body.vz,
            vx: a[i].ax, vy: a[i].ay, vz: a[i].az
        }));
    }

    function shift(state, k, factor) {
        return state.map((body, i) => ({
            ...body,
            x: body.x + k[i].x * factor,
            y: body.y + k[i].y * factor,
            z: body.z + k[i].z * factor,
            vx: body.vx + k[i].vx * factor,
            vy: body.vy + k[i].vy * factor,
            vz: body.vz + k[i].vz * factor
        }));
    }

    function addEvent(type, bodies, message) {
        const key = type + ":" + bodies.slice().sort((a, b) => a - b).join("-");
        if (EVENT_KEYS.has(key)) return;
        EVENT_KEYS.add(key);
        EVENTS.push({ type, bodies, message, time });
        renderEvents();
    }

    function detectEvents() {
        let collision = false;
        let ejection = false;

        for (let i = 0; i < B.length; i++) {
            for (let j = i + 1; j < B.length; j++) {
                const distance = Math.hypot(
                    B[i].x - B[j].x,
                    B[i].y - B[j].y,
                    B[i].z - B[j].z
                );
                if (distance <= COLLISION_DISTANCE) {
                    addEvent("collision", [i, j], `Столкновение тел ${i + 1} и ${j + 1}`);
                    collision = true;
                }
            }
        }

        for (let i = 0; i < B.length; i++) {
            if (EVENT_KEYS.has("ejection:" + i)) continue;
            const pair = B.filter((_, j) => j !== i);
            const a = pair[0], b = pair[1], body = B[i];
            const pairMass = a.m + b.m;
            const center = {
                x: (a.m * a.x + b.m * b.x) / pairMass,
                y: (a.m * a.y + b.m * b.y) / pairMass,
                z: (a.m * a.z + b.m * b.z) / pairMass,
                vx: (a.m * a.vx + b.m * b.vx) / pairMass,
                vy: (a.m * a.vy + b.m * b.vy) / pairMass,
                vz: (a.m * a.vz + b.m * b.vz) / pairMass
            };
            const rx = body.x - center.x;
            const ry = body.y - center.y;
            const rz = body.z - center.z;
            const rvx = body.vx - center.vx;
            const rvy = body.vy - center.vy;
            const rvz = body.vz - center.vz;
            const distance = Math.hypot(rx, ry, rz);
            const radial = rx * rvx + ry * rvy + rz * rvz;
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
        for (let i = 0; i < B.length; i++) {
            for (let j = i + 1; j < B.length; j++) {
                distances.push(Math.hypot(
                    B[i].x - B[j].x,
                    B[i].y - B[j].y,
                    B[i].z - B[j].z
                ));
            }
        }
        maxSeparation = Math.max(maxSeparation, ...distances);

        if (time >= STABILITY_CHECK_DAYS && !stabilityReported && EVENTS.length === 0 && maxSeparation < EJECTION_DISTANCE) {
            stabilityReported = true;
            addEvent("stable", [], "Предварительно устойчивое движение за 500 суток");
        }

        if (collision || ejection) {
            run = false;
            acc = 0;
            $("tb-start").disabled = true;
            $("tb-start").textContent = collision ? "Столкновение" : "Выброс тела";
            setStatus("Модель остановлена");
            showToast(
                collision ? "Модель остановлена: обнаружено столкновение" : "Модель остановлена: обнаружен выброс тела"
            );
        }
    }

    function renderEvents() {
        const panel = $("tb-events");
        if (!panel) return;
        if (!EVENTS.length) {
            panel.innerHTML = "<strong>События:</strong> пока не обнаружены";
            return;
        }
        panel.innerHTML = "<strong>Обнаруженные события:</strong><ul>" +
            EVENTS.map(event => `<li>${event.message} — ${fmt(event.time, 2)} суток</li>`).join("") +
            "</ul>";
    }

    function clearEvents() {
        EVENTS = [];
        EVENT_KEYS.clear();
        ejectionSince = {};
        maxSeparation = 0;
        stabilityReported = false;
        renderEvents();
    }

    function step() {
        const a = derivatives(B);
        const b = derivatives(shift(B, a, DT / 2));
        const d = derivatives(shift(B, b, DT / 2));
        const e = derivatives(shift(B, d, DT));

        B = B.map((body, i) => ({
            ...body,
            x: body.x + DT / 6 * (a[i].x + 2 * b[i].x + 2 * d[i].x + e[i].x),
            y: body.y + DT / 6 * (a[i].y + 2 * b[i].y + 2 * d[i].y + e[i].y),
            z: body.z + DT / 6 * (a[i].z + 2 * b[i].z + 2 * d[i].z + e[i].z),
            vx: body.vx + DT / 6 * (a[i].vx + 2 * b[i].vx + 2 * d[i].vx + e[i].vx),
            vy: body.vy + DT / 6 * (a[i].vy + 2 * b[i].vy + 2 * d[i].vy + e[i].vy),
            vz: body.vz + DT / 6 * (a[i].vz + 2 * b[i].vz + 2 * d[i].vz + e[i].vz)
        }));

        time += DT;
        B.forEach((body, i) => {
            T[i].push({ x: body.x, y: body.y, z: body.z });
            if (T[i].length > TRAIL_MAX) T[i].shift();
        });
        detectEvents();
    }

    function energy() {
        let total = 0;
        B.forEach(body => {
            total += 0.5 * body.m * (body.vx ** 2 + body.vy ** 2 + body.vz ** 2);
        });
        for (let i = 0; i < B.length; i++) {
            for (let j = i + 1; j < B.length; j++) {
                const distance = Math.hypot(
                    B[j].x - B[i].x,
                    B[j].y - B[i].y,
                    B[j].z - B[i].z
                );
                total -= G * B[i].m * B[j].m / Math.max(distance, 1e-9);
            }
        }
        return total;
    }

    // ---------- Сохранение существующей логики панели параметров ----------
    function draftFor(index) {
        if (!DRAFT[index]) {
            DRAFT[index] = {
                vx: B[index].vx,
                vy: B[index].vy,
                vz: B[index].vz
            };
        }
        return DRAFT[index];
    }

    function editor() {
        const fields = $("tb-fields");
        const help = $("tb-help");
        if (sel < 0) {
            fields.hidden = true;
            help.hidden = false;
            $("tb-editor-title").textContent = "Выбери тело";
            render();
            return;
        }

        const body = B[sel];
        const draft = draftFor(sel);
        fields.hidden = false;
        help.hidden = true;
        $("tb-editor-title").textContent = "Тело " + (sel + 1);
        $("tb-mass").value = body.m;
        $("tb-mass-range").value = clamp(body.m, 0.0001, 10);
        $("tb-mass-out").textContent = fmt(body.m, 5);
        $("tb-x").value = body.x.toFixed(5);
        $("tb-y").value = body.y.toFixed(5);
        $("tb-z").value = body.z.toFixed(5);
        $("tb-vel").value = velocityXY(draft).toFixed(3);
        $("tb-vel-range").value = clamp(velocityXY(draft), 0, 100);
        $("tb-vel-out").textContent = fmt(velocityXY(draft));
        $("tb-angle").value = (Math.atan2(draft.vy, draft.vx) * 180 / Math.PI).toFixed(2);
        $("tb-vz").value = velocityZ(draft).toFixed(3);
        render();
    }

    function reset() {
        run = false;
        time = 0;
        acc = 0;
        T = B.map(body => [{ x: body.x, y: body.y, z: body.z }]);
        clearEvents();
        $("tb-start").disabled = false;
        $("tb-start").textContent = "Запустить";
        updateStartControl();
        setStatus("Модель остановлена");
        render();
    }

    function resetAll() {
        B = INITIAL.map(body => ({ ...body }));
        DRAFT = {};
        DIRTY = {};
        $("tb-preset").value = activePreset;
        reset();
        editor();
    }

    function resetSelected() {
        if (sel < 0) return;
        B[sel] = { ...INITIAL[sel] };
        delete DRAFT[sel];
        delete DIRTY[sel];
        reset();
        editor();
    }

    function clearSelection() {
        if (sel < 0) return;
        const old = sel;
        const hadChanges = !!DIRTY[old];
        delete DRAFT[old];
        delete DIRTY[old];
        updateStartControl();
        sel = -1;
        bodyPointer = null;
        vectorPointer = false;
        dragBodyIndex = -1;
        controls.enabled = true;
        editor();
        if (hadChanges) $("tb-status").textContent = "Неподтверждённые изменения отменены";
    }

    function read() {
        return {
            m: +$("tb-mass").value,
            x: +$("tb-x").value,
            y: +$("tb-y").value,
            z: +$("tb-z").value,
            v: +$("tb-vel").value,
            vz: +$("tb-vz").value,
            a: +$("tb-angle").value
        };
    }

    function commitSelectedChanges(parameters) {
        if (sel < 0) return;
        const draft = draftFor(sel);
        B[sel].m = parameters.m;
        B[sel].x = parameters.x;
        B[sel].y = parameters.y;
        B[sel].z = parameters.z;
        B[sel].vx = draft.vx;
        B[sel].vy = draft.vy;
        B[sel].vz = draft.vz;
        delete DRAFT[sel];
        delete DIRTY[sel];
    }

    function applyMass(all) {
        const p = read();
        if (!Number.isFinite(p.m) || p.m <= 0 || p.m > 1000) {
            showToast("Масса должна быть больше нуля и не превышать 1000 масс Солнца.");
            return;
        }
        if (sel >= 0) commitSelectedChanges(p);
        markCustom();
        if (all) B.forEach(body => body.m = p.m);
        setStatus(all ? "Масса применена ко всем телам" : "Масса применена к телу");
        reset();
        editor();
    }

    function applyVelocity(all) {
        const p = read();
        if (!Number.isFinite(p.v) || p.v < 0 || p.v > 10000 || !Number.isFinite(p.vz) || Math.abs(p.vz) > 10000) {
            showToast("Проверь компоненты скорости. Допустимое значение по каждой оси: от -10000 до 10000 км/с.");
            return;
        }
        if (sel >= 0) commitSelectedChanges(p);
        markCustom();
        if (all) {
            B.forEach(body => {
                const angle = Math.atan2(body.vy, body.vx);
                setV(body, p.v, angle * 180 / Math.PI);
            });
        } else if (sel >= 0) {
            setV(B[sel], p.v, p.a);
            B[sel].vz = p.vz * KM_S_TO_AU_DAY;
        }
        setStatus(all ? "Скорость применена ко всем телам" : "Скорость применена к телу");
        reset();
        editor();
    }

    function updateDraftFromInputs() {
        if (sel < 0) return;
        const xySpeed = +$("tb-vel").value;
        const angle = +$("tb-angle").value;
        const zSpeed = +$("tb-vz").value;
        if (![xySpeed, angle, zSpeed].every(Number.isFinite)) return;
        const draft = draftFor(sel);
        setV(draft, xySpeed, angle);
        draft.vz = zSpeed * KM_S_TO_AU_DAY;
        markPendingChange();
        markCustom();
        $("tb-vel-out").textContent = fmt(xySpeed);
        $("tb-vel-range").value = clamp(xySpeed, 0, 100);
        render();
    }

    // ---------- Выбор тел и перетаскивание в 3D ----------
    renderer.domElement.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        setPointerRay(event);

        if (sel >= 0 && !run) {
            const handleHit = raycaster.intersectObject(bodyObjects[sel].handle, false)[0];
            if (handleHit) {
                vectorPointer = true;
                dragBodyIndex = sel;
                const origin = bodyObjects[sel].mesh.position;
                dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), origin);
                controls.enabled = false;
                renderer.domElement.setPointerCapture(event.pointerId);
                event.stopImmediatePropagation();
                return;
            }
        }

        const hits = raycaster.intersectObjects(bodyObjects.map(item => item.mesh), false);
        if (hits.length) {
            const index = hits[0].object.userData.bodyIndex;
            if (sel >= 0 && sel !== index) {
                const hadChanges = !!DIRTY[sel];
                delete DRAFT[sel];
                delete DIRTY[sel];
                updateStartControl();
                if (hadChanges) $("tb-status").textContent = "Неподтверждённые изменения отменены";
            }
            sel = index;
            dragBodyIndex = index;
            bodyPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
            const origin = bodyObjects[index].mesh.position;
            dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), origin);
            controls.enabled = false;
            renderer.domElement.setPointerCapture(event.pointerId);
            editor();
            event.stopImmediatePropagation();
            return;
        }

        blankPointer = { x: event.clientX, y: event.clientY, moved: false };
    }, true);

    renderer.domElement.addEventListener("pointermove", event => {
        if (blankPointer && Math.hypot(event.clientX - blankPointer.x, event.clientY - blankPointer.y) > 4) {
            blankPointer.moved = true;
        }

        if (vectorPointer && dragBodyIndex >= 0 && !run) {
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
            editor();
            return;
        }

        if (!bodyPointer || dragBodyIndex < 0) return;
        const moved = Math.hypot(event.clientX - bodyPointer.x, event.clientY - bodyPointer.y);
        if (moved > 4) bodyPointer.moved = true;
        if (!bodyPointer.moved) return;

        const point = pointOnDragPlane(event);
        if (!point) return;
        const body = B[dragBodyIndex];
        body.x = point.x;
        body.y = point.y;
        body.z = point.z;
        T[dragBodyIndex] = [{ x: body.x, y: body.y, z: body.z }];
        markCustom();
        $("tb-x").value = body.x.toFixed(5);
        $("tb-y").value = body.y.toFixed(5);
        $("tb-z").value = body.z.toFixed(5);
        render();
    });

    function finishPointer(event) {
        if (bodyPointer) {
            bodyPointer = null;
            dragBodyIndex = -1;
            controls.enabled = true;
            if (renderer.domElement.hasPointerCapture(event.pointerId)) {
                renderer.domElement.releasePointerCapture(event.pointerId);
            }
            render();
        }
        if (vectorPointer) {
            vectorPointer = false;
            dragBodyIndex = -1;
            controls.enabled = true;
            if (renderer.domElement.hasPointerCapture(event.pointerId)) {
                renderer.domElement.releasePointerCapture(event.pointerId);
            }
            editor();
        }
        if (blankPointer) {
            const wasClick = !blankPointer.moved;
            blankPointer = null;
            if (wasClick) clearSelection();
        }
    }

    renderer.domElement.addEventListener("pointerup", finishPointer);
    renderer.domElement.addEventListener("pointercancel", finishPointer);

    // ---------- Обработчики панели: прежние действия плюс координата Z и Vz ----------
    $("tb-mass").oninput = () => {
        $("tb-mass-range").value = clamp(+$("tb-mass").value || 0.0001, 0.0001, 10);
        $("tb-mass-out").textContent = fmt(+$("tb-mass").value || 0, 5);
        markPendingChange();
    };
    $("tb-mass-range").oninput = event => {
        $("tb-mass").value = event.target.value;
        $("tb-mass-out").textContent = fmt(+event.target.value, 5);
        markPendingChange();
    };
    ["tb-x", "tb-y", "tb-z"].forEach(id => $(id).oninput = markPendingChange);
    $("tb-vel").oninput = updateDraftFromInputs;
    $("tb-vel-range").oninput = event => {
        $("tb-vel").value = event.target.value;
        updateDraftFromInputs();
    };
    $("tb-angle").oninput = updateDraftFromInputs;
    $("tb-vz").oninput = updateDraftFromInputs;

    $("tb-apply").onclick = () => {
        if (sel < 0) return;
        const p = read();
        if (![p.m, p.x, p.y, p.z, p.v, p.vz, p.a].every(Number.isFinite) ||
            p.m <= 0 || p.m > 1000 ||
            Math.abs(p.x) > 10000 || Math.abs(p.y) > 10000 || Math.abs(p.z) > 10000 ||
            p.v < 0 || p.v > 10000 || Math.abs(p.vz) > 10000) {
            showToast("Проверь массу, координаты и компоненты скорости.");
            return;
        }
        commitSelectedChanges(p);
        setV(B[sel], p.v, p.a);
        B[sel].vz = p.vz * KM_S_TO_AU_DAY;
        markCustom();
        setStatus("Параметры тела применены");
        reset();
        editor();
    };

    $("tb-cancel").onclick = () => {
        if (sel < 0) return;
        delete DRAFT[sel];
        delete DIRTY[sel];
        editor();
        updateStartControl();
        setStatus("Несохранённые изменения отменены");
    };
    $("tb-reset-selected").onclick = resetSelected;
    $("tb-mass-all").onclick = () => applyMass(true);
    $("tb-velocity-all").onclick = () => applyVelocity(true);
    $("tb-preset").onchange = event => preset(event.target.value);
    $("tb-start").onclick = () => {
        if (hasPendingChanges()) {
            showToast("Сначала примени параметры или нажми «Отмена».");
            return;
        }
        run = !run;
        $("tb-start").textContent = run ? "Остановить" : "Продолжить";
        bodyObjects.forEach(object => object.handle.visible = !run);
        setStatus(run ? "Симуляция выполняется" : "Симуляция остановлена");
    };
    $("tb-reset").onclick = resetAll;
    $("tb-speed").oninput = event => {
        speed = +event.target.value;
        $("tb-speed-out").textContent = speed + "×";
    };

    window.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;
        run = false;
        acc = 0;
        $("tb-start").disabled = false;
        clearSelection();
        $("tb-start").textContent = "Продолжить";
        $("tb-status").textContent = "Симуляция остановлена";
    });

    function frame(now) {
        if (!last) last = now;
        const elapsed = Math.min((now - last) / 1000, 0.05);
        last = now;
        if (run) {
            acc += elapsed * speed * 2;
            let iterations = 0;
            while (run && acc >= DT && iterations++ < 500) {
                step();
                acc -= DT;
            }
        }
        controls.update();
        render();
        requestAnimationFrame(frame);
    }

    // Начальная конфигурация и запуск цикла отображения.
    B = PRESETS.figure8.map(a => ({
        x: a[0], y: a[1], z: a[2],
        vx: a[3] * SQRT_G,
        vy: a[4] * SQRT_G,
        vz: a[5] * SQRT_G,
        m: a[6]
    }));
    INITIAL = B.map(body => ({ ...body }));
    $("tb-preset").value = activePreset;
    resize();
    editor();
    reset();
    window.addEventListener("resize", resize);
    if ("ResizeObserver" in window) {
        new ResizeObserver(resize).observe(stage);
    }
    requestAnimationFrame(frame);
})();
