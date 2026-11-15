export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function seedFor(text) {
    let seed = 2166136261;
    for (const character of text) {
        seed = Math.imul(seed ^ character.codePointAt(0), 16777619);
    }
    return seed >>> 0;
}

export function randomFrom(seed) {
    return () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

export function fitCanvas(canvas) {
    const {width, height} = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
    }
    const context = canvas.getContext("2d");
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    return {context, width, height};
}

function blend(a, b, t) {
    return a + (b - a) * t;
}

function terrainNoise(seed) {
    const size = 128;
    const random = randomFrom(seed);
    const values = Float32Array.from({length: size * size}, random);
    const cell = (x, y) => values[(y & (size - 1)) * size + (x & (size - 1))];
    return (x, y) => {
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        const dx = x - ix;
        const dy = y - iy;
        const smoothX = dx * dx * (3 - 2 * dx);
        const smoothY = dy * dy * (3 - 2 * dy);
        return blend(
            blend(cell(ix, iy), cell(ix + 1, iy), smoothX),
            blend(cell(ix, iy + 1), cell(ix + 1, iy + 1), smoothX),
            smoothY,
        );
    };
}

export function planetSprite({name, palette, texture = "terrain", atmosphere = 0, shell, diameter = 180}) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = diameter;
    const context = canvas.getContext("2d");
    const image = context.createImageData(diameter, diameter);
    const radius = diameter * (shell?.opacity ? .426 : .448);
    // Имя планеты задаёт воспроизводимый рисунок поверхности.
    const noise = terrainNoise(seedFor(name));
    const star = texture === "star";
    const banded = texture === "bands";
    const earth = texture === "earth";
    const [dark, mid, light] = palette;
    const center = diameter / 2;

    for (let py = 0; py < diameter; py++) {
        for (let px = 0; px < diameter; px++) {
            const x = (px + .5 - center) / radius;
            const y = (py + .5 - center) / radius;
            const r2 = x * x + y * y;
            const index = (py * diameter + px) * 4;
            if (r2 > 1 && shell?.opacity) {
                const r = Math.sqrt(r2);
                const distance = r - 1;
                if (distance <= shell.width) {
                    const lit = clamp((-.63 * x - .5 * y) / r + .50, .12, 1);
                    const falloff = (1 - distance / shell.width) ** 1.65;
                    image.data.set(shell.color, index);
                    image.data[index + 3] = 255 * shell.opacity * lit * falloff;
                }
                continue;
            }
            if (r2 > 1.002) continue;
            const z = Math.sqrt(Math.max(0, 1 - r2));
            const lon = Math.atan2(x, z);
            const lat = Math.asin(clamp(y, -1, 1));
            const u = lon * 5 + 27;
            const v = lat * 5 + 53;
            const broad = noise(u * .53, v * .53);
            const medium = noise(u * 1.35 + 14, v * 1.35);
            const detail = noise(u * 3.5, v * 3.5 + 21);
            const grain = noise(u * 9.2, v * 9.2);
            let terrain = .48 * broad + .28 * medium + .16 * detail + .08 * grain;
            if (banded) {
                const wind = lat * 25 + noise(lon * 3 + 28, lat * 14 + 10) * 1.8;
                terrain = .4 * terrain + .6 * (.5 + .31 * Math.sin(wind) + .16 * Math.sin(wind * 2.8));
            }
            if (star) terrain = .51 * medium + .3 * detail + .19 * grain;
            const land = earth && terrain > .52 && Math.abs(lat) < 1.27;
            const low = land ? [34, 62, 53] : dark;
            const base = land ? [105, 137, 83] : mid;
            const high = land ? [163, 151, 95] : light;
            const contrast = clamp((terrain - .12) / .76, 0, 1);
            const illumination = Math.max(0, -.58 * x - .46 * y + .67 * z);
            const brightness = star ? .93 + .23 * z : .115 + .96 * illumination ** .68;
            const rim = (1 - z) ** 3 * illumination * atmosphere;
            const cloud = earth ? clamp((noise(u * 1.5 + 44, v * 2.5) * .66 + detail * .34 - .60) * 4.7, 0, .82) : 0;
            const polar = earth ? clamp((Math.abs(lat) - 1.2) * 2.3, 0, .9) : 0;
            for (let channel = 0; channel < 3; channel++) {
                const pigment = contrast < .52
                    ? blend(low[channel], base[channel], contrast / .52)
                    : blend(base[channel], high[channel], (contrast - .52) / .48);
                image.data[index + channel] = blend(pigment, 230, Math.max(cloud, polar)) * brightness
                    + rim * (shell?.color[channel] ?? [106, 165, 214][channel]);
            }
            image.data[index + 3] = 255 * clamp((1 - Math.sqrt(r2)) * radius + .55, 0, 1);
        }
    }
    context.putImageData(image, 0, 0);
    return canvas;
}

export function glow(context, x, y, radius, color) {
    const halo = context.createRadialGradient(x, y, 0, x, y, radius);
    halo.addColorStop(0, color);
    halo.addColorStop(1, "transparent");
    context.fillStyle = halo;
    context.fillRect(x - radius, y - radius, 2 * radius, 2 * radius);
}
