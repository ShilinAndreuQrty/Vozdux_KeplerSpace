import {observeSky, unobserveSky} from "./sky.js";
import {clamp, fitCanvas, glow, planetSprite} from "./graphics.js";

const catalog = document.querySelector("#catalog-grid");
const card = document.querySelector("#planet-card");
const ranking = document.querySelector("#ranking-list");
const search = document.querySelector("#planet-search");
const empty = document.querySelector("#ranking-empty");
const count = document.querySelector("#ranking-count");
const message = document.querySelector("#catalog-status");
const refresh = document.querySelector("#refresh-archive");
const archiveStatus = document.querySelector("#archive-status");
const desktop = window.matchMedia("(min-width: 726px)");
const palettes = [
    [[23, 43, 68], [69, 115, 169], [181, 218, 242]],
    [[34, 45, 62], [100, 152, 161], [218, 230, 216]],
    [[58, 45, 57], [161, 128, 122], [244, 205, 163]],
    [[69, 29, 34], [188, 96, 70], [254, 200, 133]],
];

let cardObserver;
let cardRequest;

function planetPalette(flux) {
    if (!Number.isFinite(flux) || flux <= 0) return palettes[1];
    const tone = clamp(Math.log2(flux) * .62 + 1.18, 0, palettes.length - 1);
    const a = Math.floor(tone);
    const b = Math.ceil(tone);
    return palettes[a].map((color, i) => color.map((channel, j) =>
        Math.round(channel + (palettes[b][i][j] - channel) * (tone - a))));
}

function atmosphereStyle(planet, palette) {
    // Толщина видимой оболочки зависит от T/(gR). При пропусках берём земные значения.
    const radius = planet.radius > 0 ? planet.radius : 1;
    const gravity = planet.mass > 0 ? planet.mass / radius ** 2 : 1;
    const temperature = planet.temperature > 0 ? planet.temperature
        : planet.flux > 0 ? 255 * planet.flux ** .25 : 255;
    const scale = clamp(Math.sqrt((temperature / 255) / (gravity * radius)), .55, 2);
    const gasGiant = planet.giant === "classified";
    const opacity = planet.atmosphere ?? (gasGiant ? .88 : .57);
    return {
        width: clamp(.16 * scale * opacity, .055, .165),
        opacity: clamp(opacity * (1.1 + .15 * Math.log2(1 + Math.max(0, planet.flux ?? 1))), 0, 1),
        color: palette[2].map((channel, i) => Math.round(.52 * channel + .48 * [155, 211, 255][i])),
    };
}

function paintPortrait(canvas, sprite, planet, palette) {
    const {context, width, height} = fitCanvas(canvas);
    if (!context || !width || !height) return;
    context.clearRect(0, 0, width, height);
    const radius = planet.radius ?? 1;
    const diameter = Math.min(width * .85, height * .77) * clamp(.89 + Math.log2(radius) * .15, .62, 1.19);
    const x = width * .57;
    const y = height * .48;
    const light = palette[2].join(", ");
    glow(context, x - diameter * .17, y - diameter * .12, diameter * .94, "rgba(" + light + ", .17)");

    context.drawImage(sprite, x - diameter / 2, y - diameter / 2, diameter, diameter);
}

function mountCard() {
    const planet = JSON.parse(card.querySelector("#planet-graphics").textContent);
    const portrait = card.querySelector("#planet-portrait");
    const palette = planetPalette(planet.flux);
    const shell = atmosphereStyle(planet, palette);
    card.querySelector("#portrait-atmosphere").hidden = shell.opacity === 0;
    const art = card.querySelector(".planet-hero");
    art.style.setProperty("--planet-ambient", "rgba(" + palette[1].join(", ") + ", .35)");
    observeSky(card.querySelector("[data-sky]"));
    const sprite = portrait.getContext("2d") && planetSprite({
        name: planet.name, palette, texture: planet.giant ? "bands" : "terrain",
        atmosphere: shell.opacity, shell, diameter: 420,
    });

    cardObserver = new ResizeObserver(entries => {
        for (const {target} of entries) {
            if (target === portrait && sprite) paintPortrait(portrait, sprite, planet, palette);
        }
    });
    cardObserver.observe(portrait);
}

async function openCard(name, href, pushState, focusCard) {
    cardRequest?.abort();
    const controller = new AbortController();
    cardRequest = controller;
    const url = new URL(catalog.dataset.cardUrl, location.href);
    url.searchParams.set("planet", name);
    card.setAttribute("aria-busy", "true");
    message.textContent = "";
    try {
        const response = await fetch(url, {signal: controller.signal});
        if (!response.ok) throw new Error("card unavailable");
        const template = document.createElement("template");
        template.innerHTML = await response.text();
        if (controller.signal.aborted) return;
        cardObserver?.disconnect();
        unobserveSky(card.querySelector("[data-sky]"));
        card.replaceChildren(template.content);
        mountCard();
        for (const row of ranking.querySelectorAll("[data-planet]")) {
            if (row.dataset.planet === name) row.setAttribute("aria-current", "true");
            else row.removeAttribute("aria-current");
        }
        if (pushState) history.pushState({planet: name}, "", href);
        if (focusCard) {
            card.querySelector("#planet-name").focus({preventScroll: true});
        }
        if (pushState && (!desktop.matches || card.getBoundingClientRect().top < -32)) {
            card.scrollIntoView({block: "start"});
        }
    } catch {
        if (!controller.signal.aborted) message.textContent = "Карточка не загрузилась. Попробуй открыть её ещё раз.";
    } finally {
        if (cardRequest === controller) card.removeAttribute("aria-busy");
    }
}

function filterRanking() {
    const normalize = text => text.toLocaleLowerCase("ru").replace(/[-'’\s]/g, "");
    const query = normalize(search.value.trim());
    let matches = 0;
    for (const row of ranking.children) {
        row.hidden = !normalize(row.dataset.search).includes(query);
        if (!row.hidden) matches++;
    }
    empty.hidden = matches > 0;
    ranking.hidden = matches === 0;
    count.textContent = query ? "Найдено в топ‑50: " + matches : count.dataset.initial;
    ranking.scrollTop = 0;
}

if (catalog) {
    mountCard();
    const currentName = card.querySelector("[data-selected]").dataset.selected;
    history.replaceState({planet: currentName}, "");
    count.dataset.initial = count.textContent;
    for (const swatch of ranking.querySelectorAll("[data-flux]")) {
        const [, , color] = planetPalette(swatch.dataset.flux ? Number(swatch.dataset.flux) : null);
        swatch.style.setProperty("--swatch", "rgb(" + color.join(", ") + ")");
    }
    search.addEventListener("input", filterRanking);
    document.addEventListener("click", event => {
        if (event.target.closest('a[href="#habitability-method"]')) document.querySelector("#habitability-method").open = true;
    });
    catalog.addEventListener("click", event => {
        const link = event.target.closest("a[data-planet]");
        if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        const focusCard = !desktop.matches || !link.matches(".rank-row");
        openCard(link.dataset.planet, link.href, true, focusCard);
    });
    window.addEventListener("popstate", event => {
        if (event.state?.planet) openCard(event.state.planet, location.href, false, false);
        else location.reload();
    });
}

if (location.hash === "#habitability-method") {
    const method = document.querySelector("#habitability-method");
    if (method) method.open = true;
}

refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    archiveStatus.textContent = "Загружаю данные NASA…";
    try {
        const response = await fetch(refresh.dataset.url, {method: "POST"});
        const result = await response.json();
        if (!response.ok) throw new Error(result.message);
        location.reload();
    } catch (error) {
        archiveStatus.textContent = error instanceof TypeError ? "Обновление сейчас недоступно." : error.message;
        refresh.disabled = false;
    }
});
