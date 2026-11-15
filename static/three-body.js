import { bodyRadius, firstContact, stateAtContact } from "./three-body-collision.js";
import { createParticleImpact } from "./three-body-particles.js";
import { clearToast, showToast } from "./three-body-toast.js";

(() => {
    const canvas = document.getElementById("tb-canvas");
    if (!canvas) return;

    const byId = id => document.getElementById(id);
    const context = canvas.getContext("2d");

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
    const BODY_COLORS = ["#8ddcff", "#ffc58e", "#c7a5ff"];
    const PARTICLE_COLORS = BODY_COLORS.map(color => color.slice(1).match(/../g).map(hex => parseInt(hex, 16)));

    // Порядок значений в пресете — x, y, vx, vy, масса.
    const PRESETS = {
        figure8: [
            [-0.97000436, 0.24308753, 0.466203685, 0.43236573, 1],
            [0.97000436, -0.24308753, 0.466203685, 0.43236573, 1],
            [0, 0, -0.93240737, -0.86473146, 1]
        ],
        triangle: [
            [0, 0, 0, 0, 1],
            [1.2, 0, 0, 0, 1],
            [0.6, 1.0392304845, 0, 0, 1]
        ],
        collision: [
            [-1.1, 0, 0.24, 0, 1],
            [1.1, 0, -0.24, 0, 1],
            [0, 1.55, 0, 0.12, 0.6]
        ],
        grazing: [
            [-0.85, 0, 0.34, -0.165, 1],
            [0.85, 0, -0.34, 0.165, 1],
            [0, 2.15, 0, 0.12, 0.6]
        ],
        chaos: [
            [-1.05, 0.25, 0.12, 0.55, 1],
            [0.82, 0.52, -0.28, -0.12, 1],
            [0.12, -0.82, 0.34, -0.18, 1]
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
    let draggedIndex = -1;
    let vectorDrag = false;
    let dragPending = false;
    let dragStart = null;
    let dragTimer = null;
    const viewport = { x: 0, y: 0, scale: 100 };
    let activePreset = "figure8";
    let ejectionSince = {};
    let maxSeparation = 0;
    let stabilityReported = false;
    let impact = null;

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const formatNumber = (value, digits = 3) => Number(value).toFixed(digits).replace(".", ",");

    function markCustom() {
        byId("tb-preset").value = "custom";
    }

    function setStatus(message) {
        byId("tb-status").textContent = message;
    }

    function hasPendingChanges() {
        return Object.keys(pendingChanges).length > 0;
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
        setStatus("Есть несохранённые изменения. Примени их или нажми «Отмена».");
    }

    function setVelocity(body, velocityKmS, angleDegrees) {
        const angle = (angleDegrees * Math.PI) / 180;
        const velocity = velocityKmS * KM_S_TO_AU_DAY;
        body.vx = velocity * Math.cos(angle);
        body.vy = velocity * Math.sin(angle);
    }

    const speedKmS = body => Math.hypot(body.vx, body.vy) / KM_S_TO_AU_DAY;

    function randomChaos() {
        const bodies = [];
        const minDistance = 0.65;

        // При случайном размещении избегаем тесного сближения тел.
        for (let i = 0; i < 3; i++) {
            let body,
                attempts = 0;

            do {
                body = {
                    x: (Math.random() * 2 - 1) * 1.2,
                    y: (Math.random() * 2 - 1) * 1.2
                };
                attempts++;
            } while (
                bodies.some(other => Math.hypot(body.x - other.x, body.y - other.y) < minDistance) &&
                attempts < 100
            );

            bodies.push(body);
        }

        return bodies.map(body => [
            body.x,
            body.y,
            Math.random() * 0.4 - 0.2,
            Math.random() * 0.4 - 0.2,
            1
        ]);
    }

    function preset(name) {
        activePreset = name;
        resize();

        const source = name === "chaos" ? randomChaos() : PRESETS[name];

        bodies = source.map(entry => ({
            x: entry[0],
            y: entry[1],
            vx: entry[2] * SQRT_G,
            vy: entry[3] * SQRT_G,
            m: entry[4]
        }));
        if (name === "triangle") {
            const side = 1.2;
            const triangleMass = bodies.reduce((sum, body) => sum + body.m, 0);
            const centerX = bodies.reduce((sum, body) => sum + body.m * body.x, 0) / triangleMass;
            const centerY = bodies.reduce((sum, body) => sum + body.m * body.y, 0) / triangleMass;
            const angularSpeed = Math.sqrt((G * triangleMass) / side ** 3);
            bodies.forEach(body => {
                const x = body.x - centerX;
                const y = body.y - centerY;
                body.x = x;
                body.y = y;
                body.vx = -angularSpeed * y;
                body.vy = angularSpeed * x;
            });
        }

        // Переходим в систему отсчёта центра масс.
        const totalMass = bodies.reduce((sum, body) => sum + body.m, 0);
        const centerX = bodies.reduce((sum, body) => sum + body.m * body.x, 0) / totalMass;
        const centerY = bodies.reduce((sum, body) => sum + body.m * body.y, 0) / totalMass;

        const centerVx = bodies.reduce((sum, body) => sum + body.m * body.vx, 0) / totalMass;
        const centerVy = bodies.reduce((sum, body) => sum + body.m * body.vy, 0) / totalMass;

        bodies.forEach(body => {
            body.x -= centerX;
            body.y -= centerY;
            body.vx -= centerVx;
            body.vy -= centerVy;
        });
        initialBodies = bodies.map(body => ({ ...body }));
        velocityDrafts = {};
        pendingChanges = {};
        selectedIndex = -1;
        updateEditor();
        resetAll();
    }

    function accelerations(state) {
        return state.map((body, i) => {
            let ax = 0;
            let ay = 0;
            state.forEach((other, j) => {
                if (i === j) return;
                const dx = other.x - body.x;
                const dy = other.y - body.y;
                const distanceSquared = dx * dx + dy * dy;
                if (distanceSquared < 1e-12) return;
                const factor = (G * other.m) / (distanceSquared * Math.sqrt(distanceSquared));
                ax += dx * factor;
                ay += dy * factor;
            });
            return { ax, ay };
        });
    }

    function derivatives(state) {
        const accelerationsByBody = accelerations(state);
        return state.map((body, i) => ({
            x: body.vx,
            y: body.vy,
            vx: accelerationsByBody[i].ax,
            vy: accelerationsByBody[i].ay
        }));
    }

    function shift(state, derivative, offset) {
        return state.map((body, i) => ({
            ...body,
            x: body.x + derivative[i].x * offset,
            y: body.y + derivative[i].y * offset,
            vx: body.vx + derivative[i].vx * offset,
            vy: body.vy + derivative[i].vy * offset
        }));
    }

    function addEvent(type, bodies, message) {
        const key = type + ":" + bodies.slice().sort((a, b) => a - b).join("-");
        if (eventKeys.has(key)) return;

        eventKeys.add(key);
        events.push({ type, bodies, message, time });
        renderEvents();
    }

    function beginImpact(contact) {
        const { first, second } = contact;
        impact = createParticleImpact(bodies, contact, 2, G);
        running = false;
        timeAccumulator = 0;
        addEvent("collision", impact.indices, `Столкновение тел ${first + 1} и ${second + 1}`);
        finishPointer();
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
            trails[index].push({ x: survivor.x, y: survivor.y });
            if (trails[index].length > 2000) trails[index].shift();
        }
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
            const first = pair[0],
                second = pair[1],
                body = bodies[i];
            const mass = first.m + second.m;

            const centerX = (first.m * first.x + second.m * second.x) / mass;
            const centerY = (first.m * first.y + second.m * second.y) / mass;
            const centerVx = (first.m * first.vx + second.m * second.vx) / mass;
            const centerVy = (first.m * first.vy + second.m * second.vy) / mass;

            const rx = body.x - centerX;
            const ry = body.y - centerY;
            const rvx = body.vx - centerVx;
            const rvy = body.vy - centerVy;

            const distance = Math.hypot(rx, ry);
            const radial = rx * rvx + ry * rvy;

            // Для выброса нужна положительная энергия относительно оставшейся пары.
            const energy = 0.5 * (rvx * rvx + rvy * rvy) - (G * mass) / Math.max(distance, 1e-12);

            const candidate = distance >= EJECTION_DISTANCE && radial > 0 && energy > 0;

            if (candidate) {
                if (ejectionSince[i] === undefined) {
                    ejectionSince[i] = time;
                }

                if (time - ejectionSince[i] >= EJECTION_CONFIRM_DAYS) {
                    addEvent("ejection", [i], "Выброс тела " + (i + 1));
                    ejection = true;
                }
            } else {
                delete ejectionSince[i];
            }
        }

        const distances = [];

        for (let i = 0; i < bodies.length; i++) {
            for (let j = i + 1; j < bodies.length; j++) {
                distances.push(Math.hypot(bodies[i].x - bodies[j].x, bodies[i].y - bodies[j].y));
            }
        }

        maxSeparation = Math.max(maxSeparation, ...distances);

        if (
            time >= STABILITY_CHECK_DAYS &&
            !stabilityReported &&
            events.length === 0 &&
            maxSeparation < EJECTION_DISTANCE
        ) {
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

        panel.innerHTML =
            "<strong>Обнаруженные события:</strong><ul>" +
            events
                .map(event => "<li>" + event.message + " — " + formatNumber(event.time, 2) + " суток</li>")
                .join("") +
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
            x: body.x + (STEP_DAYS / 6) * (k1[i].x + 2 * k2[i].x + 2 * k3[i].x + k4[i].x),
            y: body.y + (STEP_DAYS / 6) * (k1[i].y + 2 * k2[i].y + 2 * k3[i].y + k4[i].y),
            vx: body.vx + (STEP_DAYS / 6) * (k1[i].vx + 2 * k2[i].vx + 2 * k3[i].vx + k4[i].vx),
            vy: body.vy + (STEP_DAYS / 6) * (k1[i].vy + 2 * k2[i].vy + 2 * k3[i].vy + k4[i].vy)
        }));

        const contact = firstContact(bodies, nextBodies);
        bodies = contact ? stateAtContact(bodies, nextBodies, contact.fraction) : nextBodies;
        time += STEP_DAYS * (contact?.fraction ?? 1);

        bodies.forEach((body, i) => {
            trails[i].push({ x: body.x, y: body.y });
            if (trails[i].length > 2000) trails[i].shift();
        });

        if (contact) beginImpact(contact);
        else detectOrbitalEvents();
    }

    function energy() {
        let total = 0;
        bodies.forEach(body => (total += 0.5 * body.m * (body.vx * body.vx + body.vy * body.vy)));
        for (let i = 0; i < 3; i++) {
            for (let j = i + 1; j < 3; j++) {
                const dx = bodies[j].x - bodies[i].x;
                const dy = bodies[j].y - bodies[i].y;
                total -= (G * bodies[i].m * bodies[j].m) / Math.max(Math.sqrt(dx * dx + dy * dy), 1e-9);
            }
        }
        return total;
    }

    function resize() {
        const bounds = canvas.getBoundingClientRect();
        const pixelRatio = Math.min(devicePixelRatio || 1, 2);
        canvas.width = bounds.width * pixelRatio;
        canvas.height = bounds.height * pixelRatio;
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        const grazing = activePreset === "grazing";
        viewport.scale = Math.min(bounds.width, bounds.height) / (grazing ? 3.35 : 4.67);
        viewport.x = bounds.width / 2;
        viewport.y = bounds.height / 2 + (grazing ? 0.28 * viewport.scale : 0);
    }

    // Ось Y холста направлена вниз.
    const toScreen = point => ({
        x: viewport.x + point.x * viewport.scale,
        y: viewport.y - point.y * viewport.scale
    });
    const toSimulation = point => ({
        x: (point.x - viewport.x) / viewport.scale,
        y: -(point.y - viewport.y) / viewport.scale
    });

    function drawArrow(context, x, y, dx, dy, color) {
        const angle = Math.atan2(dy, dx);
        const headLength = 12;
        context.strokeStyle = color;
        context.fillStyle = color;
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x + dx, y + dy);
        context.stroke();
        context.beginPath();
        context.moveTo(x + dx, y + dy);
        context.lineTo(
            x + dx - headLength * Math.cos(angle - 0.45),
            y + dy - headLength * Math.sin(angle - 0.45)
        );
        context.lineTo(
            x + dx - headLength * Math.cos(angle + 0.45),
            y + dy - headLength * Math.sin(angle + 0.45)
        );
        context.fill();
    }

    function drawGrid(width, height) {
        context.save();
        const { scale } = viewport;
        const gridStep = scale > 190 ? 0.25 : scale > 80 ? 0.5 : 1;
        const left = -viewport.x / scale;
        const right = (width - viewport.x) / scale;
        const bottom = -(height - viewport.y) / scale;
        const top = viewport.y / scale;
        context.strokeStyle = "#9eb7d522";
        context.fillStyle = "#9eb7d5";
        context.font = "10px sans-serif";
        for (let x = Math.ceil(left / gridStep) * gridStep; x <= right; x += gridStep) {
            const screenX = viewport.x + x * scale;
            context.beginPath();
            context.moveTo(screenX, 0);
            context.lineTo(screenX, height);
            context.stroke();
            if (x) context.fillText(String(+x.toFixed(2)), screenX + 3, viewport.y + 12);
        }
        for (let y = Math.ceil(bottom / gridStep) * gridStep; y <= top; y += gridStep) {
            const screenY = viewport.y - y * scale;
            context.beginPath();
            context.moveTo(0, screenY);
            context.lineTo(width, screenY);
            context.stroke();
            if (y) context.fillText(String(+y.toFixed(2)), viewport.x + 5, screenY - 3);
        }
        context.strokeStyle = "#c4d5eb88";
        context.lineWidth = 1.4;
        context.beginPath();
        context.moveTo(0, viewport.y);
        context.lineTo(width, viewport.y);
        context.moveTo(viewport.x, 0);
        context.lineTo(viewport.x, height);
        context.stroke();
        context.fillStyle = "#d3dfef";
        context.fillText("X, а.е.", width - 48, viewport.y - 7);
        context.fillText("Y, а.е.", viewport.x + 7, 13);
        context.restore();
    }

    function drawDebris({ indices, particles, remnant }) {
        indices.forEach((index, group) => {
            context.fillStyle = BODY_COLORS[index];
            context.strokeStyle = BODY_COLORS[index];
            context.lineWidth = 1;
            context.globalAlpha = 0.22;
            context.beginPath();
            for (const p of particles) {
                if (p.group !== group || !(p.tail?.length > 1)) continue;
                const first = toScreen(p.tail[0]);
                context.moveTo(first.x, first.y);
                for (let i = 1; i < p.tail.length; i++) {
                    const point = toScreen(p.tail[i]);
                    context.lineTo(point.x, point.y);
                }
                const last = toScreen(p);
                context.lineTo(last.x, last.y);
            }
            context.stroke();
            context.globalAlpha = 0.82;
            for (const p of particles) {
                if (p.group !== group) continue;
                const { x, y } = toScreen(p);
                context.fillRect(x - 0.62, y - 0.62, 1.24, 1.24);
            }
        });
        context.globalAlpha = 1;

        if (remnant.m > 0) {
            const [first, second] = indices.map(index => PARTICLE_COLORS[index]);
            const channels = first.map((channel, i) => Math.round(channel + (second[i] - channel) * remnant.mix));
            const point = toScreen(remnant);
            context.fillStyle = `rgb(${channels.join(",")})`;
            context.beginPath();
            context.arc(point.x, point.y, viewport.scale * Math.sqrt(remnant.measure), 0, 2 * Math.PI);
            context.fill();
        }
    }

    function render() {
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        context.clearRect(0, 0, width, height);
        drawGrid(width, height);
        trails.forEach((points, i) => {
            if (points.length < 2) return;
            context.beginPath();
            points.forEach((point, j) => {
                const projected = toScreen(point);
                j ? context.lineTo(projected.x, projected.y) : context.moveTo(projected.x, projected.y);
            });
            context.strokeStyle = BODY_COLORS[i] + "99";
            context.lineWidth = 1.5;
            context.stroke();
        });
        bodies.forEach((body, i) => {
            if (impact?.indices.includes(i)) return;
            const point = toScreen(body);
            const radius = bodyRadius(body.m) * viewport.scale;
            const glow = context.createRadialGradient(point.x, point.y, 1, point.x, point.y, radius * 3);
            glow.addColorStop(0, BODY_COLORS[i] + "99");
            glow.addColorStop(1, BODY_COLORS[i] + "00");
            context.fillStyle = glow;
            context.beginPath();
            context.arc(point.x, point.y, radius * 3, 0, 7);
            context.fill();
            context.fillStyle = BODY_COLORS[i];
            context.beginPath();
            context.arc(point.x, point.y, radius, 0, 7);
            context.fill();
            context.strokeStyle = selectedIndex === i ? "white" : "#ffffff99";
            context.lineWidth = selectedIndex === i ? 2.5 : 1;
            context.stroke();
            context.fillStyle = "#e4edfa";
            context.font = "11px sans-serif";
            context.fillText("Тело " + (i + 1), point.x + 11, point.y - 11);
            // До применения параметров стрелка показывает черновик скорости.
            const velocity =
                !running && selectedIndex === i && pendingChanges[i] && velocityDrafts[i]
                    ? velocityDrafts[i]
                    : body;
            const angle = Math.atan2(velocity.vy, velocity.vx);
            const arrowLength = clamp(speedKmS(velocity) * 2.0, 16, 90);
            drawArrow(
                context,
                point.x,
                point.y,
                Math.cos(angle) * arrowLength,
                -Math.sin(angle) * arrowLength,
                BODY_COLORS[i]
            );
        });
        if (impact) drawDebris(impact);
        byId("tb-time").textContent = formatNumber(time, 2) + " суток";
    }

    function resetSimulation() {
        if (impact) {
            impact = null;
            clearToast();
        }
        running = false;
        time = 0;
        timeAccumulator = 0;
        trails = bodies.map(body => [{ x: body.x, y: body.y }]);
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
    function draftFor(index) {
        if (!velocityDrafts[index]) velocityDrafts[index] = { vx: bodies[index].vx, vy: bodies[index].vy };
        return velocityDrafts[index];
    }
    function updateEditor() {
        const fields = byId("tb-fields");
        const help = byId("tb-help");
        if (selectedIndex < 0) {
            fields.hidden = true;
            help.hidden = false;
            byId("tb-editor-title").textContent = "Выбери тело";
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
        const velocityKmS = speedKmS(draft);
        byId("tb-vel").value = velocityKmS.toFixed(3);
        byId("tb-vel-range").value = clamp(velocityKmS, 0, 100);
        byId("tb-vel-out").textContent = formatNumber(velocityKmS);
        byId("tb-angle").value = ((Math.atan2(draft.vy, draft.vx) * 180) / Math.PI).toFixed(2);
    }
    function clearSelection() {
        if (selectedIndex < 0) return;

        const previousIndex = selectedIndex;
        const hadChanges = !!pendingChanges[previousIndex];

        delete velocityDrafts[previousIndex];
        delete pendingChanges[previousIndex];
        updateStartControl();

        selectedIndex = -1;
        draggedIndex = -1;
        vectorDrag = false;

        updateEditor();
        render();

        if (hadChanges) {
            byId("tb-status").textContent = "Неподтверждённые изменения отменены";
        }
    }
    function readParameters() {
        return {
            m: +byId("tb-mass").value,
            x: +byId("tb-x").value,
            y: +byId("tb-y").value,
            v: +byId("tb-vel").value,
            a: +byId("tb-angle").value
        };
    }
    function commitSelectedChanges(parameters) {
        if (selectedIndex < 0) return;
        const draft = draftFor(selectedIndex);
        bodies[selectedIndex].m = parameters.m;
        bodies[selectedIndex].x = parameters.x;
        bodies[selectedIndex].y = parameters.y;
        bodies[selectedIndex].vx = draft.vx;
        bodies[selectedIndex].vy = draft.vy;
        delete velocityDrafts[selectedIndex];
        delete pendingChanges[selectedIndex];
    }
    function applyMass(all) {
        const parameters = readParameters();
        if (!Number.isFinite(parameters.m) || parameters.m <= 0 || parameters.m > 1000) {
            showToast("Масса должна быть больше нуля и не превышать 1000 масс Солнца.");
            return;
        }
        if (selectedIndex >= 0) {
            commitSelectedChanges(parameters);
        }
        markCustom();
        if (all) {
            bodies.forEach(body => (body.m = parameters.m));
        }
        setStatus(all ? "Масса применена ко всем телам" : "Масса применена к телу");
        resetSimulation();
        updateEditor();
    }
    function applyVelocity(all) {
        const parameters = readParameters();
        if (!Number.isFinite(parameters.v) || parameters.v < 0 || parameters.v > 10000) {
            showToast("Скорость должна быть от 0 до 10000 км/с.");
            return;
        }
        if (selectedIndex >= 0) {
            commitSelectedChanges(parameters);
        }
        markCustom();
        if (all) {
            bodies.forEach(body => {
                const angle = Math.atan2(body.vy, body.vx);
                const velocity = parameters.v * KM_S_TO_AU_DAY;
                body.vx = velocity * Math.cos(angle);
                body.vy = velocity * Math.sin(angle);
            });
        } else if (selectedIndex >= 0) {
            setVelocity(bodies[selectedIndex], parameters.v, parameters.a);
        }
        setStatus(all ? "Скорость применена ко всем телам" : "Скорость применена к телу");
        resetSimulation();
        updateEditor();
    }
    function updateDraftFromInputs() {
        if (selectedIndex < 0) return;
        const velocityKmS = +byId("tb-vel").value;
        const angle = +byId("tb-angle").value;
        if (!Number.isFinite(velocityKmS) || !Number.isFinite(angle)) return;
        setVelocity(draftFor(selectedIndex), velocityKmS, angle);
        markPendingChange();
        markCustom();
        byId("tb-vel-out").textContent = formatNumber(velocityKmS);
        byId("tb-vel-range").value = clamp(velocityKmS, 0, 100);
        render();
    }
    canvas.addEventListener("pointerdown", event => {
        if (impact) return;
        const bounds = canvas.getBoundingClientRect();
        const pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        if (selectedIndex >= 0) {
            const body = bodies[selectedIndex];
            const draft = draftFor(selectedIndex);
            const screenPosition = toScreen(body);
            const angle = Math.atan2(draft.vy, draft.vx);
            const arrowLength = clamp(speedKmS(draft) * 2.0, 16, 90);
            const tip = {
                x: screenPosition.x + Math.cos(angle) * arrowLength,
                y: screenPosition.y - Math.sin(angle) * arrowLength
            };

            if (Math.hypot(tip.x - pointer.x, tip.y - pointer.y) < 24) {
                vectorDrag = true;
                canvas.setPointerCapture(event.pointerId);
                return;
            }
        }
        const bodyIndex = bodies.findIndex(body => {
            const screenPosition = toScreen(body);
            return Math.hypot(screenPosition.x - pointer.x, screenPosition.y - pointer.y) <= bodyRadius(body.m) * viewport.scale;
        });
        if (bodyIndex >= 0) {
            if (bodyIndex !== selectedIndex && selectedIndex >= 0) {
                const hadChanges = !!pendingChanges[selectedIndex];
                delete velocityDrafts[selectedIndex];
                delete pendingChanges[selectedIndex];
                updateStartControl();
                if (hadChanges) {
                    byId("tb-status").textContent = "Неподтверждённые изменения отменены";
                }
            }
            selectedIndex = bodyIndex;
            updateEditor();

            dragPending = true;
            dragStart = pointer;
            draggedIndex = -1;

            canvas.setPointerCapture(event.pointerId);

            // Короткое удержание отличает перетаскивание от выбора тела.
            dragTimer = setTimeout(() => {
                if (dragPending) {
                    draggedIndex = bodyIndex;
                    dragPending = false;
                }
            }, 65);

            render();
        } else if (selectedIndex >= 0) {
            clearSelection();
        }
    });
    canvas.addEventListener("pointermove", event => {
        const bounds = canvas.getBoundingClientRect();
        const pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };

        if (vectorDrag && selectedIndex >= 0 && !running) {
            const origin = toScreen(bodies[selectedIndex]);
            const dx = pointer.x - origin.x;
            const dy = origin.y - pointer.y;
            const draft = draftFor(selectedIndex);
            const velocityKmS = speedKmS(draft);
            const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

            setVelocity(draft, velocityKmS, angle);
            markPendingChange();
            markCustom();
            updateEditor();
            render();
            return;
        }

        if (dragPending) {
            if (Math.hypot(pointer.x - dragStart.x, pointer.y - dragStart.y) > 5) {
                clearTimeout(dragTimer);
                dragTimer = null;
                dragPending = false;
            }
            return;
        }
        if (draggedIndex < 0) return;

        const position = toSimulation(pointer);
        bodies[draggedIndex].x = position.x;
        bodies[draggedIndex].y = position.y;
        trails[draggedIndex] = [{ ...position }];
        markCustom();
        updateEditor();
        render();
    });
    function finishPointer() {
        if (dragTimer) {
            clearTimeout(dragTimer);
            dragTimer = null;
        }
        dragPending = false;
        draggedIndex = -1;
        vectorDrag = false;
    }
    canvas.addEventListener("pointerup", finishPointer);
    canvas.addEventListener("pointercancel", finishPointer);
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
    byId("tb-x").oninput = markPendingChange;
    byId("tb-y").oninput = markPendingChange;
    byId("tb-vel").oninput = updateDraftFromInputs;
    byId("tb-vel-range").oninput = event => {
        byId("tb-vel").value = event.target.value;
        updateDraftFromInputs();
    };
    byId("tb-angle").oninput = updateDraftFromInputs;
    byId("tb-apply").onclick = () => {
        if (selectedIndex < 0) return;
        const p = readParameters();
        if (
            ![p.m, p.x, p.y].every(Number.isFinite) ||
            p.m <= 0 ||
            p.m > 1000 ||
            Math.abs(p.x) > 10000 ||
            Math.abs(p.y) > 10000
        ) {
            showToast("Проверь массу и координаты.");
            return;
        }
        commitSelectedChanges(p);
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
        setStatus(running ? "Симуляция выполняется" : "Симуляция остановлена");
    };
    byId("tb-reset").onclick = resetAll;
    byId("tb-speed").oninput = event => {
        speed = +event.target.value;
        byId("tb-speed-out").textContent = speed + "×";
    };
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
        render();
        requestAnimationFrame(frame);
    }
    window.addEventListener("keydown", event => {
        if (event.key !== "Escape" || hasTerminalEvent()) return;

        running = false;
        timeAccumulator = 0;

        byId("tb-start").disabled = false;
        byId("tb-start").textContent = "Продолжить";

        clearSelection();

        byId("tb-status").textContent = "Симуляция остановлена";
    });
    bodies = PRESETS.figure8.map(entry => ({
        x: entry[0],
        y: entry[1],
        vx: entry[2] * SQRT_G,
        vy: entry[3] * SQRT_G,
        m: entry[4]
    }));
    initialBodies = bodies.map(b => ({ ...b }));
    resize();
    updateEditor();
    resetSimulation();
    window.addEventListener("resize", () => {
        resize();
        render();
    });
    requestAnimationFrame(frame);
})();
