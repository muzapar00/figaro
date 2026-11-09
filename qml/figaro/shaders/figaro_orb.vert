#version 440

layout(location = 0) in vec4 qt_Vertex;
layout(location = 1) in vec2 qt_MultiTexCoord0;

// Same std140 block as the fragment stage: Qt Quick feeds one uniform buffer to
// both stages, so the layouts have to match exactly.
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

layout(location = 0) out vec2 vCoord;

void main()
{
    // Derive coordinates from the vertex position rather than a texture
    // coordinate: a ShaderEffect with no source item is not guaranteed to be
    // handed qt_MultiTexCoord0, but it always has vertices.
    vCoord = qt_Vertex.xy / vec2(max(uWidth, 1.0), max(uHeight, 1.0));
    gl_Position = qt_Matrix * qt_Vertex;
}
