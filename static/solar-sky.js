import {fitCanvas, randomFrom, seedFor} from "./graphics.js";

function nebulaTexture() {
    const texture = document.createElement("canvas");
    texture.width = 256;
    texture.height = 128;
    const context = texture.getContext("2d");
    if (!context) return texture;
    const random = randomFrom(seedFor("KeplerSpace nebula texture"));
    context.translate(128, 64);
    context.scale(1, .53);
    for (let i = 0; i < 32; i++) {
        const x = (random() - .5) * 132;
        const y = Math.sin(x / 35) * 31 + (random() - .5) * 47;
        const radius = 20 + random() * 39;
        const cloud = context.createRadialGradient(x, y, 0, x, y, radius);
        cloud.addColorStop(0, i % 3 ? "rgba(84, 117, 156, .18)" : "rgba(125, 94, 149, .12)");
        cloud.addColorStop(.5, "rgba(61, 81, 129, .06)");
        cloud.addColorStop(1, "#0000");
        context.fillStyle = cloud;
        context.fillRect(x - radius, y - radius, 2 * radius, 2 * radius);
    }
    return texture;
}

export function createSolarSky(canvas) {
    const random = randomFrom(seedFor("KeplerSpace celestial sphere"));
    const stars = Array.from({length: 2800}, (_, i) => {
        const longitude = random() * Math.PI * 2;
        const z = i < 1850 ? 2 * random() - 1 : (random() + random() - 1) * .23;
        const radius = Math.sqrt(1 - z * z);
        const x = Math.cos(longitude) * radius;
        const y = Math.sin(longitude) * radius;
        // В наклонной полосе небесной сферы звёзд больше.
        return [x, y * .76 - z * .65, y * .65 + z * .76, random()];
    });
    const nebula = nebulaTexture();
    const clouds = [
        [-.18, -.84, -.20, -.32, .33],
        [.72, -.75, -.78, .43, .24],
    ];
    let surface = fitCanvas(canvas);
    let previousYaw, previousTilt, previousZoom;

    return {
        resize() {
            surface = fitCanvas(canvas);
            previousYaw = undefined;
        },
        draw({yaw, tilt, zoom}, {yawCos, yawSin, tiltCos, tiltSin}) {
            const {context, width, height} = surface;
            if (!context || !width || !height) return;
            if (yaw === previousYaw && tilt === previousTilt && zoom === previousZoom) return;
            previousYaw = yaw;
            previousTilt = tilt;
            previousZoom = zoom;

            context.clearRect(0, 0, width, height);
            const focalLength = Math.max(width, height) * .49 * zoom ** .12;
            const centerX = width * .5;
            const centerY = height * .5;
            for (const [x, y, z, angle, opacity] of clouds) {
                const vertical = x * yawSin + y * yawCos;
                const depth = -(vertical * tiltCos + z * tiltSin);
                if (depth < .35) continue;
                const scale = focalLength / depth;
                const sx = centerX + (x * yawCos - y * yawSin) * scale;
                const sy = centerY + (vertical * tiltSin - z * tiltCos) * scale;
                if (sx < -scale || sx > width + scale || sy < -scale || sy > height + scale) continue;
                context.save();
                context.translate(sx, sy);
                context.rotate(angle);
                context.globalAlpha = opacity * Math.min(1, (depth - .35) / .35);
                context.drawImage(nebula, -scale * .48, -scale * .24, scale * .96, scale * .48);
                context.restore();
            }
            for (const [x, y, z, light] of stars) {
                const vertical = x * yawSin + y * yawCos;
                const depth = -(vertical * tiltCos + z * tiltSin);
                if (depth <= .2) continue;
                const scale = focalLength / depth;
                const sx = centerX + (x * yawCos - y * yawSin) * scale;
                const sy = centerY + (vertical * tiltSin - z * tiltCos) * scale;
                if (sx < -2 || sx > width + 2 || sy < -2 || sy > height + 2) continue;
                const bright = light > .98;
                const size = bright ? 2.25 : .55 + light * .65;
                context.fillStyle = light > .9 ? "#f2e1c8" : "#c1d4f2";
                if (bright) {
                    context.globalAlpha = .16;
                    context.fillRect(sx - 2.1, sy - .5, 4.2, 1);
                    context.fillRect(sx - .5, sy - 2.1, 1, 4.2);
                    context.fillStyle = "#f5f5ff";
                }
                context.globalAlpha = bright ? .97 : .14 + light ** 2 * .68;
                context.fillRect(sx - size / 2, sy - size / 2, size, size);
            }
            context.globalAlpha = 1;
        },
    };
}
