#version 440

// Figaro orb, simplified.
//
// Apple's motion guidance asks for motion that is purposeful, brief and
// precise, and that never competes with content. The first version of this
// shader had five colour stops, white filaments, a travelling ripple and a
// specular sheen all moving at once, which read as decoration rather than as
// state. This one keeps a single idea: a soft ball of light whose hue drifts
// very slowly and whose brightness follows the microphone. State is carried by
// size and glow, not by extra props.

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
    return mix(
        mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
        u.y);
}

float fbm(vec2 p)
{
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
        v += a * noise(p);
        p = p * 2.03 + 17.1;
        a *= 0.5;
    }
    return v;
}

// Three stops only: indigo, violet, pale cyan. A tight ramp keeps the ball
// readable at a glance; wider ramps looked like a lava lamp.
vec3 ramp(float k)
{
    const vec3 c0 = vec3(0.14, 0.10, 0.38);
    const vec3 c1 = vec3(0.46, 0.32, 0.92);
    const vec3 c2 = vec3(0.62, 0.86, 0.96);
    k = clamp(k, 0.0, 1.0);
    vec3 col = mix(c0, c1, smoothstep(0.05, 0.62, k));
    return mix(col, c2, smoothstep(0.68, 0.98, k));
}

void main()
{
    vec2 res = vec2(max(uWidth, 1.0), max(uHeight, 1.0));
    vec2 uv = (vCoord - 0.5) * 2.0;
    uv.x *= res.x / res.y;

    float t = uTime;
    // Thinking breathes a little faster; everything else is slow. Nothing races.
    float speed = mix(0.35, 0.62, uThinking) + uLevel * 0.35;
    float phase = t * speed;

    // One warp pass is enough at this size; the eye reads it as flow.
    vec2 warp = uv * 2.1;
    float flow = fbm(warp + vec2(0.0, phase * 0.16) + fbm(warp * 1.4 - phase * 0.10) * 0.7);

    float r = length(uv);
    float radius = mix(0.50, 0.54, uEnergy) + uLevel * 0.035;

    // Soft silhouette with a gentle wobble. A hard circle looked like a logo;
    // a strongly wobbling blob looked like an egg. This is in between.
    float wob = 0.035 * sin(3.1 * uv.x * 2.4 + phase) + 0.028 * sin(4.3 * uv.y * 2.4 - phase * 0.8);
    float d = r - (radius + wob * (0.5 + uLevel));

    float core = smoothstep(0.045, -0.030, d);

    // Colour follows a slowly turning angle so the surface drifts instead of
    // flickering; the hue bias per state is tiny on purpose.
    vec2 sp = uv / max(radius, 0.001);
    float ang = atan(sp.y, sp.x) * 0.15915494;
    float k = 0.5 + 0.5 * sin((ang + flow * 0.28 - phase * 0.02 + uHue * 0.12) * TAU);
    vec3 col = ramp(k * 0.92);

    // Depth: lit from the middle, darker at the edge, so it reads as a sphere.
    float depth = smoothstep(radius * 1.02, radius * 0.05, r);
    col *= 0.52 + 0.62 * depth;

    // Brightness answers the microphone, but gently: at rest it is a calm ball,
    // while loud speech lifts the middle without strobing.
    col += ramp(0.80) * pow(depth, 2.2) * (0.10 + 0.45 * uLevel);

    // Soft edge + tight halo. No white outline: an outline reads as a sticker.
    float bloom = exp(-max(d, 0.0) * 9.0);
    col += ramp(0.62) * bloom * 0.35;
    float halo = exp(-max(d, 0.0) * 5.0) * (1.0 - core);
    col += ramp(0.55) * halo * (0.18 + 0.25 * uEnergy);

    float alpha = clamp(core * 0.97 + bloom * 0.22 + halo * 0.16, 0.0, 1.0) * uOpacity;
    fragColor = vec4(clamp(col, 0.0, 1.0) * alpha, alpha);
}
