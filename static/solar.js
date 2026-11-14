import "./sky.js";
import {clamp, fitCanvas, glow, planetSprite} from "./graphics.js";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const DAY = 86400000;
const MOSCOW_OFFSET = 3 * 3600000;
const MIN_DATE = Date.UTC(1800, 0, 1) - MOSCOW_OFFSET;
const MAX_DATE = Date.UTC(2051, 0, 1) - MOSCOW_OFFSET - 1;
const DEFAULT_CAMERA = {yaw: -.27, tilt: .51, zoom: 1, panX: 0, panY: 0};
const camera = {...DEFAULT_CAMERA};
const formatter = new Intl.NumberFormat("ru-RU", {maximumFractionDigits: 2});
const clockFormatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Etc/GMT-3", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
});

// NASA/JPL Table 1. a, e, I, L, longitude of perihelion, longitude of ascending node.
// Positions for Earth use the Earth–Moon barycenter.
const bodies = [
    {id: "sun", name: "Солнце", type: "Звезда", radius: 695700, size: 54, color: "#ffc185", texture: "star",
        palette: [[157, 64, 19], [255, 166, 76], [255, 239, 162]]},
    {id: "mercury", name: "Меркурий", type: "Планета земной группы", radius: 2439.4, period: 87.97, size: 12, color: "#c5aa9e",
        palette: [[45, 34, 35], [142, 117, 105], [213, 193, 166]],
        elements: [.38709927, .20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
        rates: [.00000037, .00001906, -.00594749, 149472.67411175, .16047689, -.12534081]},
    {id: "venus", name: "Венера", type: "Планета земной группы", radius: 6051.8, period: 224.70, size: 20, color: "#eccc90", atmosphere: .57, texture: "bands",
        palette: [[92, 66, 40], [195, 156, 91], [255, 225, 151]],
        elements: [.72333566, .00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
        rates: [.00000390, -.00004107, -.00078890, 58517.81538729, .00268329, -.27769418]},
    {id: "earth", name: "Земля", type: "Планета земной группы", radius: 6371.0, period: 365.26, size: 23, color: "#8cc9ff", atmosphere: .88, texture: "earth",
        palette: [[21, 40, 81], [44, 105, 169], [128, 202, 242]],
        elements: [1.00000261, .01671123, -.00001531, 100.46457166, 102.93768193, 0],
        rates: [.00000562, -.00004392, -.01294668, 35999.37244981, .32327364, 0]},
    {id: "mars", name: "Марс", type: "Планета земной группы", radius: 3389.5, period: 686.98, size: 16, color: "#e08a68",
        palette: [[77, 32, 31], [179, 87, 55], [249, 175, 123]],
        elements: [1.52371034, .09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
        rates: [.00001847, .00007882, -.00813131, 19140.30268499, .44441088, -.29257343]},
    {id: "jupiter", name: "Юпитер", type: "Газовый гигант", radius: 69911, period: 4332.59, size: 49, color: "#e0af90", texture: "bands",
        palette: [[86, 49, 46], [181, 132, 102], [247, 220, 182]],
        elements: [5.20288700, .04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
        rates: [-.00011607, -.00013253, -.00183714, 3034.74612775, .21252668, .20469106]},
    {id: "saturn", name: "Сатурн", type: "Газовый гигант", radius: 58232, period: 10759.22, size: 38, color: "#f6d6a1", texture: "bands",
        palette: [[94, 67, 54], [189, 157, 104], [252, 221, 156]],
        elements: [9.53667594, .05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
        rates: [-.00125060, -.00050991, .00193609, 1222.49362201, -.41897216, -.28867794]},
    {id: "uranus", name: "Уран", type: "Ледяной гигант", radius: 25362, period: 30688.50, size: 32, color: "#99e4e5", texture: "bands",
        palette: [[36, 71, 94], [89, 157, 164], [172, 226, 225]],
        elements: [19.18916464, .04725744, .77263783, 313.23810451, 170.95427630, 74.01692503],
        rates: [-.00196176, -.00004397, -.00242939, 428.48202785, .40805281, .04240589]},
    {id: "neptune", name: "Нептун", type: "Ледяной гигант", radius: 24622, period: 60182, size: 29, color: "#83a9fb", texture: "bands",
        palette: [[25, 38, 84], [68, 111, 171], [140, 178, 246]],
        elements: [30.06992276, .00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
        rates: [.00026291, .00005105, .00035372, 218.45945325, -.32241464, -.00508664]},
];

const canvas = document.querySelector("#solar-scene");
const timeLabel = document.querySelector("#solar-time");
const timeMode = document.querySelector("#solar-time-mode");
const pauseButton = document.querySelector("#solar-pause");
const reverseButton = document.querySelector("#solar-reverse");
const speedSelect = document.querySelector("#solar-speed");
const datePanel = document.querySelector("#solar-date");
const dateForm = document.querySelector("#solar-date-form");
const dateInput = document.querySelector("#solar-date-input");
const bodyName = document.querySelector("#body-name");
const bodyType = document.querySelector("#body-type");
const bodyFacts = document.querySelector("#body-facts");
const bodyButtons = [...document.querySelectorAll("[data-body]")];
const objectPanel = document.querySelector(".object-panel");
const detailPanel = document.querySelector(".object-detail");
const initialContext = canvas.getContext("2d");
let viewport = fitCanvas(canvas);
let selected = null;
let drawPositions = [];
let anchorTime = Date.now();
let anchorFrame = performance.now();
let speed = 1;
let direction = 1;
let paused = false;
let live = true;
let lastFrame = -Infinity;
let lastSecond = -1;
let dirty = true;
let drag = null;

function orbitalElements(body, time) {
    const centuries = (time / DAY + 2440587.5 - 2451545) / 36525;
    const [a, e, inc, mean, peri, node] = body.elements.map((value, i) => value + body.rates[i] * centuries);
    const inclination = inc * DEG;
    const longitude = node * DEG;
    const argument = (peri - node) * DEG;
    const c = Math.cos(argument);
    const s = Math.sin(argument);
    const n = Math.cos(longitude);
    const m = Math.sin(longitude);
    const p = Math.cos(inclination);
    const q = Math.sin(inclination);
    return {
        a, e, mean: ((mean - peri) * DEG) % TAU,
        u: [c * n - s * m * p, c * m + s * n * p, s * q],
        v: [-s * n - c * m * p, -s * m + c * n * p, c * q],
    };
}

function orbitPoint(orbit, anomaly) {
    const x = orbit.a * (Math.cos(anomaly) - orbit.e);
    const y = orbit.a * Math.sqrt(1 - orbit.e ** 2) * Math.sin(anomaly);
    return orbit.u.map((value, index) => x * value + y * orbit.v[index]);
}

function currentAnomaly({mean, e}) {
    let estimate = mean;
    for (let i = 0; i < 6; i++) {
        estimate -= (estimate - e * Math.sin(estimate) - mean) / (1 - e * Math.cos(estimate));
    }
    return estimate;
}

function compressedPoint(point) {
    const distance = Math.hypot(...point);
    const factor = distance ? Math.log1p(4.7 * distance) / (distance * Math.log1p(4.7 * 31)) : 1;
    return point.map(value => value * factor);
}

function cameraFrame(width, height) {
    const mobile = width <= 720;
    return {
        x: width * 0.5,
        y: height * 0.5,
        scale: Math.min(width * (mobile ? .425 : .365), height * .71) * camera.zoom,
    };
}

function project(point, frame) {
    const [x, y, z] = point;
    const dx = x * Math.cos(camera.yaw) - y * Math.sin(camera.yaw);
    const dy = x * Math.sin(camera.yaw) + y * Math.cos(camera.yaw);
    // Positive depth is toward the viewer. Near bodies are larger and painted last.
    const depth = dy * Math.cos(camera.tilt) + z * Math.sin(camera.tilt);
    const perspective = 1 / (1 - depth * .22);
    return {
        x: frame.x + dx * frame.scale * perspective,
        y: frame.y + (dy * Math.sin(camera.tilt) - z * Math.cos(camera.tilt)) * frame.scale * perspective,
        depth,
        perspective,
    };
}

function grabAnchor(x, y) {
    const frame = cameraFrame(viewport.width, viewport.height);
    const sx = (x - frame.x) / frame.scale;
    const sy = (y - frame.y) / frame.scale;
    const denominator = Math.sin(camera.tilt) + sy * Math.cos(camera.tilt) * .22;
    // Pick a point on the orbital plane. Outside the map use the focal plane.
    const planeY = denominator > .04 ? sy / denominator : Infinity;
    const depth = Math.abs(planeY) < 1.35 ? planeY * Math.cos(camera.tilt) : 0;
    const factor = 1 - depth * .22;
    const u = sx * factor;
    const v = sy * factor;
    const dy = v * Math.sin(camera.tilt) + depth * Math.cos(camera.tilt);
    return [
        u * Math.cos(camera.yaw) + dy * Math.sin(camera.yaw),
        -u * Math.sin(camera.yaw) + dy * Math.cos(camera.yaw),
        -v * Math.cos(camera.tilt) + depth * Math.sin(camera.tilt),
    ];
}

function bodyAt(x, y) {
    for (let i = drawPositions.length - 1; i >= 0; i--) {
        const position = drawPositions[i];
        if (Math.hypot(position.x - x, position.y - y) < Math.max(10, position.diameter * .53)) return position;
    }
    return null;
}

function drawRings(context, x, y, diameter, start, end) {
    for (const [scale, color, weight] of [[.70, "#dec19a6b", 2.7], [.87, "#e5caaea8", 2], [1.02, "#e8ce9c69", 1]]) {
        context.beginPath();
        context.ellipse(x, y, diameter * scale, diameter * scale * .28, -.39, start, end);
        context.strokeStyle = color;
        context.lineWidth = weight;
        context.stroke();
    }
}

function drawLabels(context, positions, width, height, mobile) {
    const placed = [];
    const order = [...positions].reverse();
    for (const {x, y, diameter, body} of order) {
        context.font = (mobile ? "650 10px" : "650 12px") + " Manrope, sans-serif";
        const halfWidth = context.measureText(body.name).width / 2 + 3;
        const offset = diameter * .57;
        const candidates = [
            [x, y + offset + 14], [x, y - offset - 6],
            [x + offset + halfWidth + 4, y + 4], [x - offset - halfWidth - 4, y + 4],
        ];
        for (const [labelX, baseline] of candidates) {
            const box = {left: labelX - halfWidth, right: labelX + halfWidth, top: baseline - 11, bottom: baseline + 4};
            if (box.left < 4 || box.right > width - 4 || box.top < 4 || box.bottom > height - 4) continue;
            if (placed.some(other => box.left < other.right && box.right > other.left
                    && box.top < other.bottom && box.bottom > other.top)) continue;
            if (positions.some(other => {
                const r = other.diameter * .44;
                return other.x + r > box.left && other.x - r < box.right
                    && other.y + r > box.top && other.y - r < box.bottom;
            })) continue;
            context.textAlign = "center";
            context.lineWidth = 3;
            context.strokeStyle = "#080b19d9";
            context.fillStyle = "#dce8f8";
            context.strokeText(body.name, labelX, baseline);
            context.fillText(body.name, labelX, baseline);
            placed.push(box);
            break;
        }
    }
}

function draw(time) {
    const {context, width, height} = viewport;
    if (!context || !width || !height) return;
    context.clearRect(0, 0, width, height);
    const mobile = width < 690;
    const positions = [];
    const frame = cameraFrame(width, height);

    for (const body of bodies) {
        let point = [0, 0, 0];
        if (body.elements) {
            const orbit = orbitalElements(body, time);
            context.beginPath();
            for (let i = 0; i <= 120; i++) {
                const step = project(compressedPoint(orbitPoint(orbit, i / 120 * TAU)), frame);
                if (i === 0) context.moveTo(step.x, step.y);
                else context.lineTo(step.x, step.y);
            }
            context.strokeStyle = "#b2c1ee54";
            context.lineWidth = .85;
            context.stroke();
            point = orbitPoint(orbit, currentAnomaly(orbit));
        }
        const world = compressedPoint(point);
        const position = project(world, frame);
        const diameter = body.size * position.perspective * (mobile ? .76 : 1) * Math.sqrt(camera.zoom);
        positions.push({...position, diameter, body, world});
    }

    for (const {x, y, diameter, body} of positions.sort((a, b) => a.depth - b.depth)) {
        if (body.id === "sun") {
            glow(context, x, y, diameter * 2.7, "#ff9b4652");
            glow(context, x, y, diameter * 1.15, "#ffc98e95");
        } else {
            glow(context, x, y, diameter * .85, body.color + "44");
        }
        if (body.id === "saturn") drawRings(context, x, y, diameter, Math.PI, TAU);
        context.drawImage(body.sprite, x - diameter / 2, y - diameter / 2, diameter, diameter);
        if (body.id === "saturn") drawRings(context, x, y, diameter, 0, Math.PI);
    }
    drawLabels(context, positions, width, height, mobile);
    drawPositions = positions;
}

function selectBody(body) {
    selected = body;
    detailPanel.hidden = !body;
    for (const button of bodyButtons) {
        button.setAttribute("aria-pressed", String(button.dataset.body === body?.id));
    }
    if (!body) return;
    bodyName.textContent = body.name;
    bodyType.textContent = body.type;
    const facts = [["Средний радиус", formatter.format(body.radius) + " км"]];
    if (body.period) {
        facts.push(["Год", formatter.format(body.period) + " зем. сут."]);
        facts.push(["Большая полуось", formatter.format(body.elements[0]) + " а.е."]);
    }
    bodyFacts.replaceChildren(...facts.map(([label, value]) => {
        const row = document.createElement("div");
        const term = document.createElement("dt");
        const detail = document.createElement("dd");
        term.textContent = label;
        detail.textContent = value;
        row.append(term, detail);
        return row;
    }));
}

function modelTime(frame = performance.now()) {
    const time = live && !paused ? Date.now()
        : anchorTime + (paused ? 0 : (frame - anchorFrame) * speed * direction);
    return clamp(time, MIN_DATE, MAX_DATE);
}

function updateClockControls() {
    pauseButton.querySelector("[data-play]").toggleAttribute("hidden", !paused);
    pauseButton.querySelector("[data-pause]").toggleAttribute("hidden", paused);
    pauseButton.setAttribute("aria-label", paused ? "Продолжить время" : "Приостановить время");
    pauseButton.title = paused ? "Продолжить" : "Пауза";
    reverseButton.setAttribute("aria-pressed", String(direction < 0));
    const mode = paused ? "Пауза" : live ? "Реальное время" : direction < 0 ? "Обратный ход" : "Модельное время";
    timeMode.textContent = mode + " · МСК";
    timeMode.dataset.live = String(!paused && live && speed === 1);
}

function zoom(multiplier) {
    camera.zoom = clamp(camera.zoom * multiplier, .62, 2.85);
    dirty = true;
}

function moveCamera(dx, dy) {
    camera.yaw += dx;
    camera.tilt = clamp(camera.tilt + dy, .13, Math.PI / 2);
    dirty = true;
}

function frame(now) {
    const time = modelTime(now);
    const hitLimit = direction < 0 ? time <= MIN_DATE : time >= MAX_DATE;
    if (!paused && hitLimit) {
        anchorTime = time;
        live = false;
        paused = true;
        dirty = true;
        updateClockControls();
        timeMode.textContent = "Предел модели · МСК";
    }
    const second = Math.floor(time / 1000);
    const secondChanged = second !== lastSecond;
    if (secondChanged) {
        lastSecond = second;
        const date = new Date(time);
        timeLabel.textContent = clockFormatter.format(date);
        timeLabel.dateTime = date.toISOString();
    }
    if (dirty || (!paused && (speed !== 1 ? now - lastFrame > 32 : secondChanged))) {
        draw(time);
        lastFrame = now;
        dirty = false;
    }
    requestAnimationFrame(frame);
}

if (initialContext) {
    if (matchMedia("(max-width: 720px)").matches) objectPanel.open = false;
    for (const body of bodies) body.sprite = planetSprite({...body, diameter: 134});
    const resize = new ResizeObserver(() => {
        viewport = fitCanvas(canvas);
        dirty = true;
    });
    resize.observe(canvas);
    for (const button of bodyButtons) {
        button.addEventListener("click", () => {
            const body = bodies.find(item => item.id === button.dataset.body);
            selectBody(selected === body ? null : body);
        });
    }
    document.querySelector("#solar-clear").addEventListener("click", () => {
        const button = bodyButtons.find(item => item.dataset.body === selected?.id);
        selectBody(null);
        (objectPanel.open && button ? button : objectPanel.querySelector("summary")).focus({preventScroll: true});
    });
    pauseButton.addEventListener("click", () => {
        anchorTime = modelTime();
        anchorFrame = performance.now();
        paused = !paused;
        if (paused) live = false;
        updateClockControls();
    });
    speedSelect.addEventListener("change", () => {
        anchorTime = modelTime();
        anchorFrame = performance.now();
        speed = Number(speedSelect.value);
        if (speed !== 1) live = false;
        updateClockControls();
    });
    reverseButton.addEventListener("click", () => {
        anchorTime = modelTime();
        anchorFrame = performance.now();
        direction *= -1;
        live = false;
        updateClockControls();
    });
    datePanel.addEventListener("toggle", () => {
        if (!datePanel.open) return;
        dateInput.value = new Date(modelTime() + MOSCOW_OFFSET).toISOString().slice(0, 16);
        dateInput.focus({preventScroll: true});
    });
    datePanel.addEventListener("keydown", event => {
        if (event.key !== "Escape" || !datePanel.open) return;
        datePanel.open = false;
        datePanel.querySelector("summary").focus({preventScroll: true});
    });
    dateForm.addEventListener("submit", event => {
        event.preventDefault();
        const time = Date.parse(dateInput.value + "+03:00");
        if (!Number.isFinite(time) || time < MIN_DATE || time > MAX_DATE) return;
        anchorTime = time;
        anchorFrame = performance.now();
        live = false;
        paused = true;
        dirty = true;
        datePanel.open = false;
        datePanel.querySelector("summary").focus({preventScroll: true});
        updateClockControls();
    });
    document.querySelector("#solar-now").addEventListener("click", () => {
        anchorTime = Date.now();
        anchorFrame = performance.now();
        speed = 1;
        direction = 1;
        speedSelect.value = "1";
        live = true;
        paused = false;
        dirty = true;
        updateClockControls();
    });
    for (const control of document.querySelectorAll("[data-camera]")) {
        control.addEventListener("click", () => {
            if (control.dataset.camera === "reset") {
                Object.assign(camera, DEFAULT_CAMERA);
                dirty = true;
            } else zoom(control.dataset.camera === "in" ? 1.21 : 1 / 1.21);
        });
    }
    canvas.addEventListener("pointerdown", event => {
        if (!event.isPrimary || event.button !== 0) return;

        drag = {
            x: event.clientX,
            y: event.clientY,
            yaw: camera.yaw,
            tilt: camera.tilt,
            moved: false,
        };

        canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", event => {
        if (!drag || !event.isPrimary) return;

        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;

        if (!drag.moved && Math.hypot(dx, dy) < 4) return;

        camera.yaw = drag.yaw - dx * .005;
        camera.tilt = clamp(
            drag.tilt + dy * .005,
            .13,
            Math.PI / 2
        );

        drag.moved = true;
        dirty = true;
    });
    canvas.addEventListener("pointerup", event => {
        if (drag && !drag.moved) {
            const bounds = canvas.getBoundingClientRect();
            const hit = bodyAt(event.clientX - bounds.left, event.clientY - bounds.top);
            selectBody(hit?.body && selected !== hit.body ? hit.body : null);
        }
        drag = null;
    });
    canvas.addEventListener("pointercancel", () => { drag = null; });
    canvas.addEventListener("lostpointercapture", () => { drag = null; });
    canvas.addEventListener("keydown", event => {
        const delta = {ArrowLeft: [-.13, 0], ArrowRight: [.13, 0], ArrowUp: [0, -.09], ArrowDown: [0, .09]}[event.key];
        if (delta) moveCamera(...delta);
        else if (event.key === "+" || event.key === "=") zoom(1.21);
        else if (event.key === "-") zoom(1 / 1.21);
        else return;
        event.preventDefault();
    });
    canvas.addEventListener("wheel", event => {
        if (event.ctrlKey) return;
        event.preventDefault();
        zoom(event.deltaY < 0 ? 1.09 : 1 / 1.09);
    }, {passive: false});
    requestAnimationFrame(frame);
} else {
    document.querySelector("#solar-fallback").hidden = false;
    for (const control of document.querySelectorAll(".observatory button, .observatory select")) control.disabled = true;
}
