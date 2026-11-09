#version 440

// Figaro orb: an iridescent, liquid, Siri-like sphere.
//
// Shape: a domain-warped fbm field instead of a circle, so the silhouette
// breathes like a fluid. Colour: an explicit indigo -> violet -> magenta -> cyan
// -> white gradient (a cosine palette greys out when it saturates, which reads
// as a soap bubble). Lighting: a warm core hotspot under a bright rim filament,
// which is what makes the sphere look like it emits light instead of being
// tinted plastic.

layout(location = 0) in vec2 vCoord;
layout(location = 0) out vec4 fragColor;

layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;

    float uTime;
    float uLevel;
    float uEnergy;
    float uOpacity;
    float uWidth;
    float uHeight;
    float uThinking;
    float uHue;
};

const float TAU = 6.28318530718;

float hash(vec2 p)
{
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float noise(vec2 p)
{
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p)
{
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p = rot * p * 2.02 + 11.7;
        a *= 0.5;
    }
    return v;
}

// Siri-ish ramp. Explicit stops instead of a cosine palette so the mid tones
// stay saturated: the sphere should read violet/cyan, never grey.
vec3 ramp(float k)
{
    const vec3 c0 = vec3(0.10, 0.06, 0.34); // deep indigo
    const vec3 c1 = vec3(0.36, 0.18, 0.82); // violet
    const vec3 c2 = vec3(0.83, 0.28, 0.86); // magenta
    const vec3 c3 = vec3(0.30, 0.80, 0.96); // cyan
    const vec3 c4 = vec3(0.98, 0.99, 1.00); // hot white
    k = clamp(k, 0.0, 1.0);
    vec3 col = mix(c0, c1, smoothstep(0.00, 0.26, k));
    col = mix(col, c2, smoothstep(0.30, 0.54, k));
    col = mix(col, c3, smoothstep(0.58, 0.78, k));
    col = mix(col, c4, smoothstep(0.86, 1.00, k));
    return col;
}

// Signed distance to a softly wobbling circle; negative inside.
float sdBlob(vec2 p, float radius, float phase, float amp)
{
    float wob = 0.0;
    wob += 0.050 * sin(3.1 * p.x * 2.6 + phase * 1.7);
    wob += 0.038 * sin(4.3 * p.y * 2.6 - phase * 1.3);
    wob += 0.024 * sin(6.7 * (p.x + p.y) * 2.1 + phase * 2.1);
    return length(p) - (radius + wob * amp);
}

void main()
{
    vec2 res = vec2(max(uWidth, 1.0), max(uHeight, 1.0));
    // Square space: the orb must not stretch with the item aspect.
    vec2 uv = (vCoord - 0.5) * 2.0;
    uv.x *= res.x / res.y;

    float t = uTime;
    float speed = mix(0.55, 1.45, uThinking) + uLevel * 0.75;
    float phase = t * speed;

    // Three-layer warp at a finer frequency than the sphere: the detail has to
    // be smaller than the silhouette or the interior reads as a few flat
    // blobs instead of flowing liquid.
    vec2 warp = uv * 2.7;
    float flow = fbm(warp + vec2(0.0, phase * 0.22) + fbm(warp * 1.5 - phase * 0.15) * 1.1);
    float body = fbm(warp * 1.9 + vec2(flow * 1.6, -phase * 0.30) + 3.7);

    float radius = mix(0.50, 0.55, uEnergy) + uLevel * 0.055;
    float wobble = 0.18 + 0.16 * uLevel;
    float d = sdBlob(uv, radius, phase, wobble);
    float r = length(uv);

    // Core coverage with a soft edge so motion does not alias.
    float core = smoothstep(0.055, -0.035, d);

    // Colour field: bands of hue that swirl around the sphere, distorted by the
    // flow field. Sampling the ramp by a plain noise value gives large flat
    // patches; sampling it by angle gives the aurora-in-glass look, and the
    // noise bends the bands so they still churn.
    vec2 sp = uv / max(radius, 0.001);
    float ang = atan(sp.y, sp.x) * 0.15915494;   // turns, not radians
    float swirl = ang + flow * 0.50 + r * 0.55 - phase * 0.045 + uHue * 0.35;
    float k = 0.5 + 0.5 * sin(swirl * TAU);
    k = clamp(k * 0.90 + 0.03, 0.0, 0.90);
    vec3 col = ramp(k);
    // Luminance structure inside the bands, so the sphere is not a flat disc.
    col *= 0.55 + 0.85 * smoothstep(0.15, 0.85, body);

    // Volumetric shading: bright core, darker towards the silhouette, so the
    // sphere has depth instead of reading as a flat sticker.
    float depth = smoothstep(radius * 1.05, radius * 0.10, r);
    col *= 0.50 + 0.78 * depth;
    col *= 0.88 + 0.24 * (1.0 - clamp(uv.y * 0.5 + 0.5, 0.0, 1.0));

    // Fold highlights: thin bright veins along the noise ridges.
    float vein = pow(1.0 - abs(sin(swirl * TAU)), 6.0) * smoothstep(0.35, 0.95, body);
    col += vec3(0.95, 0.97, 1.00) * vein * 1.15 * core;

    // Audio: a ripple that travels outward when the user speaks, plus a small
    // overall brightening so the orb visibly answers the microphone.
    float ripple = exp(-pow((r - radius * (0.35 + uLevel * 0.85)) * 7.5, 2.0));
    col += ramp(0.75 + uLevel * 0.2) * ripple * (0.25 + uLevel * 0.75) * 0.9 * core;

    // Edge: coloured, soft, no white outline — an outline instantly reads as a
    // flat sticker pasted on the desktop.
    float rim = smoothstep(0.075, 0.0, abs(d)) * core;
    float bloom = exp(-max(d, 0.0) * 10.5) * (1.0 - core);
    col += ramp(0.62) * rim * 0.75;
    col += ramp(0.70 + uLevel * 0.1) * bloom * 0.80;

    // Specular sheen: a soft highlight up-left sells the sphere as a volume.
    float sheen = pow(clamp(1.0 - length(uv - vec2(-0.20, -0.24)) * 1.45, 0.0, 1.0), 3.0);
    col += vec3(0.92, 0.95, 1.00) * sheen * 0.30 * core;

    // Wide coloured halo, additive and soft, so it sits on any wallpaper.
    float halo = exp(-max(d, 0.0) * 8.0) * (1.0 - core);
    col += ramp(0.60) * halo * (0.55 + 0.45 * uEnergy);

    float alpha = clamp(core * 0.99 + rim * 0.28 + bloom * 0.38 + halo * 0.28, 0.0, 1.0) * uOpacity;

    // Tight bloom should stay a light film, not a plate: scale rgb by coverage.
    fragColor = vec4(clamp(col * 1.12, 0.0, 1.0) * alpha, alpha);
}
