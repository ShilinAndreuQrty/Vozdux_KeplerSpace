import {fitCanvas, glow, randomFrom, seedFor} from "./graphics.js";

function drawSky(canvas) {
    const {context, width, height} = fitCanvas(canvas);
    if (!context || !width || !height) return;
    const random = randomFrom(seedFor("KeplerSpace night sky"));
    context.clearRect(0, 0, width, height);
    const span = Math.min(width, height);

    for (let i = 0; i < 46; i++) {
        const x = random() * width;
        const y = height * (.74 - .51 * x / width + (random() - .5) * .43);
        const color = i % 3 === 0 ? "rgba(150, 126, 205, .093)" : "rgba(92, 142, 208, .077)";
        glow(context, x, y, span * (.06 + random() * .24), color);
    }

    const starCount = Math.round(Math.min(950, width * height / 1160));
    for (let i = 0; i < starCount; i++) {
        const x = random() * width;
        const y = random() * height;
        const brightness = random() ** 2.1;
        const radius = .32 + brightness * .77;
        const tint = i % 7 === 0 ? "255, 206, 181" : "198, 220, 255";
        if (brightness > .94) glow(context, x, y, 6, "rgba(170, 210, 255, .32)");
        context.fillStyle = "rgba(" + tint + ", " + (.14 + brightness * .64) + ")";
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
    }
}

const skyObserver = new ResizeObserver(entries => {
    for (const {target} of entries) drawSky(target);
});

export function observeSky(canvas) {
    if (!canvas) return;
    skyObserver.observe(canvas);
}

export function unobserveSky(canvas) {
    if (canvas) skyObserver.unobserve(canvas);
}

for (const canvas of document.querySelectorAll("[data-sky]")) {
    observeSky(canvas);
}
