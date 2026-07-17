/* ═══════════════════════════════════════════════════════════════════════
   <glass-avatar> — reusable Custom Element
   ─────────────────────────────────────────────────────────────────────────
   Layers (z-order, bottom → top):
     1. <img>   circular avatar photo (object-fit: cover)
     2. <canvas> WebGL2 lens — refracts/blurs/tints the avatar underneath
     3. <span>  "+4" — plain DOM text, never touched by the shader

   Figma source values (component defaults):
     glass 55×55, fill #232021 @ 20%, no stroke
     effect: light -45° @ 40%, refraction 80, depth 20, dispersion 50, frost 4
     text: Inter Tight 400, 15/13, -0.5%, #F6FEFC
     measured overlap: 20px  (selection badge 90 × 55 → 55+55−90)
   ═══════════════════════════════════════════════════════════════════════ */

/* ── GLSL ──────────────────────────────────────────────────────────────── */

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUV;                 // 0..1, y-down (matches CSS space)
void main() {
  vUV = vec2(aPos.x, 1.0 - aPos.y) ;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

in  vec2 vUV;
out vec4 outColor;

uniform sampler2D uTexture;      // avatar photo (sharp, cover-cropped square)
uniform sampler2D uTexBlur;      // same image, CPU-gaussian-blurred (frost)
uniform vec2  uResolution;       // canvas buffer px
uniform float uAspect;           // canvas width / height (1 = circle, >1 = pill)
uniform vec2  uAvatarCenter;     // avatar centre in lens space (lens = [-1,1]²)
uniform float uAvatarRadius;     // avatar radius in lens units (1.0 = same size)
uniform vec2  uTexScale;         // cover-crop scale (matches object-fit: cover)

uniform float uRefraction;       // 0..1     (Figma 80 → 0.80 · REF_K)
uniform float uMagnification;    // ≥1
uniform float uFrost;            // blur radius, lens units (Figma 4 → 4/55·k)
uniform float uDispersion;       // 0..1     (Figma 50 → 0.50)
uniform float uDepth;            // 0..1     (Figma 20 → 0.20)
uniform vec2  uLightDir;         // unit vector, y-down screen space
uniform float uLightIntensity;   // Figma 40% → 0.40
uniform vec3  uTintColor;        // #232021
uniform float uTintOpacity;      // Figma 20% → 0.20
uniform float uDarkStrength;     // extra dark-body opacity, right-weighted
uniform float uPhotoOpacity;     // refracted-photo contribution multiplier
uniform float uRimIntensity;
uniform float uRimWidth;         // fraction of radius
uniform float uBias;             // horizontal sampling bias toward avatar
uniform float uFade;             // x position (−1..1) where photo → dark glass
uniform float uFadeWidth;        // half-width of the photo→dark transition
uniform float uEdgeScale;        // visible disc radius / nominal radius (≈0.932)
uniform float uEdgeFadeStart;    // where photo starts detaching from the rim
uniform float uEdgeFadeAmt;      // how much it detaches (0..1)
uniform float uBandWidth;        // refractive edge-band width (frac of radius)
uniform float uBandSharp;        // how sharp the band gets (0..1)
uniform float uBandBend;         // extra radial displacement inside the band
uniform float uRimResPx;         // rendered radius (device px) above which the
                                 // shine keeps full character; melts below
uniform float uBandResPx;        // same, for the sharp/bent edge band

/* small Poisson-ish disc — 13-tap frost blur */
const int  TAPS = 13;
const vec2 DISC[13] = vec2[](
  vec2( 0.000, 0.000),
  vec2( 0.527, 0.191), vec2(-0.194, 0.527), vec2(-0.527,-0.191), vec2( 0.191,-0.527),
  vec2( 0.921, 0.389), vec2(-0.389, 0.921), vec2(-0.921,-0.389), vec2( 0.389,-0.921),
  vec2( 0.284, 0.712), vec2(-0.712, 0.284), vec2(-0.284,-0.712), vec2( 0.712,-0.284)
);

/* avatar-space point (unit disc) -> texture uv with cover crop */
vec2 avUV(vec2 a) {
  return 0.5 + (a * 0.5) * uTexScale;
}

void main() {
  /* Capsule SDF: aspect 1.0 is exactly the original circular lens. Wider
     canvases extend its centre spine while retaining true circular ends,
     producing one continuous pill with no compositing seam. */
  vec2 lensP = vUV * 2.0 - 1.0;
  lensP.x *= uAspect;
  float spine = max(uAspect - 1.0, 0.0);
  vec2 p = (lensP - vec2(clamp(lensP.x, -spine, spine), 0.0)) / uEdgeScale;
  float d = length(p);

  /* anti-aliased circular clip */
  float fw   = fwidth(d) * 1.4;
  float clip = 1.0 - smoothstep(1.0 - fw, 1.0, d);
  if (clip <= 0.0) { outColor = vec4(0.0); return; }

  /* PHYSICAL-SIZE FACTOR: tiny renders (list chips on 1×/1.25× screens)
     must read FLAT. In Figma, a 31px chip is a plain dark disc with one
     soft warm sliver — no sharp edge band, no bend, no dispersion, no
     rim. So every edge/curvature feature melts as the rendered radius
     (in device px) shrinks. Hi-DPI, larger sizes and zoomed previews
     keep the full fitted glass character.                               */
  float radPx = 1.4 / max(fw, 1e-4);            /* lens radius, device px */
  float micro = smoothstep(10.0, 34.0, radPx);  /* 0 = tiny, 1 = full     */
  /* edge band features are the FIRST thing Figma's downscale blends away
     when zooming out — a wider, earlier ramp than 'micro'. Above the
     uBandResPx radius (hi-DPI, zoomed-in) it is 1.0 and nothing changes. */
  float edgeRes = smoothstep(uBandResPx * 0.27, uBandResPx, radPx);

  /* ── pseudo-spherical lens surface ─────────────────────────────── */
  float nz     = sqrt(max(1.0 - d * d, 0.0));       /* surface height   */
  float curve  = 1.0 - nz;                          /* 0 centre → 1 rim */
  vec3  N      = normalize(vec3(p * (0.55 + uDepth), nz));
  vec3  refr   = refract(vec3(0.0, 0.0, -1.0), N, 0.752);

  /* displacement: pull samples toward the centre (magnifies) and add
     rim-curved refraction; depth scales overall lens strength          */
  float k      = uRefraction * (0.55 + 0.9 * uDepth);
  /* refractive edge band — Figma's glass shows an almost-sharp, slightly
     compressed wrap of the backdrop in a band along the boundary        */
  float tBand  = smoothstep(1.0 - uBandWidth, 1.0, d);
  vec2  pn0    = d > 1e-4 ? p / d : vec2(0.0);
  vec2  q      = p * (1.0 - k * (0.30 + 0.70 * curve))
               + refr.xy * k * 0.55 * curve
               + pn0 * (uBandBend * edgeRes) * tBand * tBand;
  q.x         -= uBias;                              /* bias toward avatar */

  /* lens point → avatar space (avatar circle = unit disc) */
  vec2 a = (q - uAvatarCenter) / (uAvatarRadius * uMagnification);

  /* chromatic dispersion — strongest on the curved refracting left edge */
  float leftBoost = 0.25 + 0.75 * smoothstep(0.45, -0.75, p.x);
  float chrom = uDispersion * 0.028 * (0.25 + 0.75 * curve) * leftBoost
              * (0.3 + 0.7 * micro);

  /* frost — two-stage blur, calibrated numerically against the Figma
     export (gaussian σ = 0.6·blurR pre-blur + disc(blurR) spread):
       1. uTexBlur is the avatar pre-blurred ON THE CPU with a true
          gaussian (Canvas2D filter) — exactly the σ the fit used, with
          none of the blocky wash a mip pyramid produces at high LOD,
       2. 13 disc taps spread it the rest of the way.
     In the edge band the shader crossfades toward the sharp texture
     and shrinks the tap radius, un-frosting the boundary.              */
  float shr      = clamp(1.0 - (uBandSharp * edgeRes) * tBand * tBand, 0.06, 1.0);
  float blurR    = uFrost * shr;
  float sharpMix = clamp((1.0 - shr) * 1.06, 0.0, 1.0);
  float soft     = max(blurR * 0.9, 0.02);           /* blurred disc edge */
  vec3  acc   = vec3(0.0);
  float accW  = 0.0;
  for (int i = 0; i < TAPS; i++) {
    vec2 s = a + DISC[i] * blurR;
    /* gaussian-blurred circular coverage of the avatar disc */
    float cvr = 1.0 - smoothstep(1.0 - soft, 1.0 + soft, length(s));
    vec2 uvR = avUV(s * (1.0 + chrom));
    vec2 uvG = avUV(s);
    vec2 uvB = avUV(s * (1.0 - chrom));
    vec3 c;
    c.r = mix(texture(uTexBlur, uvR).r, texture(uTexture, uvR).r, sharpMix);
    c.g = mix(texture(uTexBlur, uvG).g, texture(uTexture, uvG).g, sharpMix);
    c.b = mix(texture(uTexBlur, uvB).b, texture(uTexture, uvB).b, sharpMix);
    /* texture alpha = true avatar coverage (circle-masked, blur-softened):
       samples beyond the avatar disc contribute darkness, not photo      */
    float aTex = mix(texture(uTexBlur, uvG).a, texture(uTexture, uvG).a, sharpMix);
    acc  += c * (cvr * aTex);
    accW += cvr * aTex;
  }
  vec3  photo    = accW > 0.0 ? acc / max(accW, 1e-4) : vec3(0.0);
  float coverage = accW / float(TAPS);               /* soft avatar edge */

  /* photo contribution fades from left (strong) to right (dark glass) */
  /* The photo→dark fade is anchored to the avatar's actual right edge
     in lens coordinates (uAvatarCenter.x + uAvatarRadius), so it stays
     correct at ANY overlap: partial overlap fades where the avatar ends
     (for the Figma composition this lands at −0.196 — exactly the value
     the numeric fit found); full overlap pushes the edge beyond the lens
     and the fade disappears, showing refraction across the whole disc.
     uFade is a fine-tune OFFSET from that geometric edge (default 0).  */
  float fc   = uAvatarCenter.x + uAvatarRadius + uFade;
  float fade = 1.0 - smoothstep(fc - uFadeWidth, fc + uFadeWidth, p.x);
  /* fitted: photo contribution detaches from the curved rim (extreme
     grazing refraction shows almost no image there in the Figma render) */
  float eF   = 1.0 - uEdgeFadeAmt
             * pow(clamp((d - uEdgeFadeStart) / (1.0 - uEdgeFadeStart), 0.0, 1.0), 1.5);
  float w    = coverage * fade * eF * uPhotoOpacity;

  /* ── dark glass body ───────────────────────────────────────────── */
  /* measured: flat OPAQUE #232021×1.03 with ≈+2/255 rightward drift */
  float aBody = clamp(uTintOpacity + uDarkStrength, 0.0, 1.0);
  vec3  body  = uTintColor * 1.03 + vec3(0.008) * clamp(p.x, -1.0, 1.0);

  /* composite refracted photo over glass body */
  vec3  col   = mix(body, photo, w);
  float alpha = max(aBody, w * 0.97);

  /* ── thin directional rim (no CSS border; light −45° @ 40%) ───────
     FIGMA PARITY AT ANY ZOOM. The shine's physical design width is
     uRimWidth·R. When the rendered radius shrinks (browser zoom-out,
     small chips, low-DPR screens) Figma's supersampled downscale simply
     AVERAGES the hairline away — it never widens into a border. */
  vec2  pn     = d > 1e-4 ? p / d : vec2(0.0);
  /* RADIAL PROFILE — fitted per-pixel against the Figma export at 500%:
     a supersampled hairline with a flat core, an S-ramp, and no inner
     gaussian glow tail. At low resolution the ramp stays resolvable and
     exact energy conservation dims it instead of thickening it. */
  float rampD  = uRimWidth * 0.631;
  float ramp   = max(rampD, fw * 0.75);
  float ws     = ramp / rampD;
  float core   = uRimWidth * 0.224 * ws;
  float push   = max(fw - core, 0.0);
  float band   = smoothstep(1.0 - core - ramp - push,
                            1.0 - core - push, d);
  float keep   = 1.0 / ws;
  float rimRes = smoothstep(uRimResPx * 0.25, uRimResPx, radPx);
  /* Preserve a faint 12% energy floor while zoomed out. Squaring rimRes
     drove the shine to near-zero too early; this linear ramp keeps the
     hairline visible without turning it into a continuous white border. */
  keep        *= mix(0.12, 1.0, rimRes);
  /* ANGULAR PROFILE — fitted flat-topped arcs with hard cutoffs, so the
     upper-right and lower-left remain dark instead of acquiring a border. */
  float cF     = clamp(dot(pn, uLightDir), 0.0, 1.0);
  float cB     = clamp(dot(pn, -uLightDir), 0.0, 1.0);
  float arcF   = pow(smoothstep(0.357, 1.0, cF), 0.94);
  float arcB   = pow(smoothstep(0.250, 1.0, cB), 1.44);
  float rim    = band * (arcF + 0.60 * arcB * rimRes)
               * uRimIntensity * (uLightIntensity / 0.40) * keep;
  col   += vec3(0.93, 0.96, 0.95) * rim;
  alpha  = clamp(alpha + rim * 0.85, 0.0, 1.0);

  /* ±0.5/255 hash dither — removes 8-bit banding in the soft gradients */
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) / 255.0;

  outColor = vec4(col, alpha * clip);
}`;

/* ── component ─────────────────────────────────────────────────────────── */

const CSS = `
  :host {
    display: inline-block;
    position: relative;
    /* width/height set from JS: size*2 − overlap  ×  size */
  }
  .photo {
    position: absolute; left: 0; top: 0;
    border-radius: 999px;
    object-fit: cover; object-position: center;   /* shader uses same crop */
    display: block;
  }
  .lens { position: absolute; top: 0; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .label {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-family: "Inter Tight", system-ui, sans-serif;
    font-weight: 400;
    color: var(--glass-label-color, #F6FEFC);
    letter-spacing: -0.005em;            /* −0.5% */
    transform: translateY(0.5px);        /* tiny optical centring nudge */
    user-select: none; pointer-events: none;
    white-space: nowrap;
  }
`;

/* ═══════════════════════════════════════════════════════════════════════
   <glass-avatar> — ATTRIBUTE API (all optional; defaults reproduce the
   Figma design: 55px circles, glass effect refraction 80 / depth 20 /
   dispersion 50 / frost 4 / light −45° @ 40% / fill #232021 @ 20%)

   CONTENT / GEOMETRY
     image            path or URL of the avatar photo (any raster format)
     count            label text, e.g. "+4" (plain DOM, never in the canvas)
     size             circle diameter in design px          (default 55)
     overlap          visible avatar↔glass overlap in px    (default 20.6)
     zoom             magnified preview of the same design  (default 1)
     background       page background hint                  (default #232021)

   FIGMA GLASS-EFFECT VALUES (same units as the Figma panel)
     refraction       0–100                                 (default 80)
     frost            blur amount                           (default 4)
     dispersion       0–100                                 (default 50)
     depth            0–100                                 (default 20)
     light-angle      degrees                               (default −45)
     light-intensity  percent                               (default 40)
     tint             fill color                            (default #232021)
     tint-opacity     percent                               (default 20)

   RENDERER CALIBRATION (fitted once by comparing this renderer to
   Figma's on identical content — content-independent transfer-function
   constants, not per-photo tweaks; override freely)
     magnification, fade (offset from avatar edge), fade-width, edge-scale,
     edge-fade-start, edge-fade-amount,
     band-width, band-sharp, band-bend,
     rim-intensity, rim-width,
     rim-res-px, band-res-px   rendered radius (device px) above which the
                      shine / edge band keep full character; below it they
                      melt toward Figma's flat small-chip look.
     effect-scale     set "1" for strictly proportional effects
                      (default: auto — Figma-style absolute px)

   GUARANTEES
     · The shader never inspects photo content; every term is a function
       of geometry, resolution and the attributes above, so any avatar
       image behaves proportionally.
     · Each instance owns its textures/GL state; instances are fully
       independent and clean up on removal from the DOM.
   ═══════════════════════════════════════════════════════════════════════ */
class GlassAvatar extends HTMLElement {

  static get observedAttributes() {
    return ['image','count','size','overlap','pill-width','background',
            'refraction','frost','dispersion','depth',
            'light-angle','light-intensity','tint','tint-opacity',
            'magnification','dark-strength','photo-opacity','rim-intensity','rim-width',
            'bias','fade','fade-width','edge-scale',
            'edge-fade-start','edge-fade-amount',
            'band-width','band-sharp','band-bend','zoom','effect-scale','seed',
            'rim-res-px','band-res-px'];
  }

  /* Figma-derived defaults + calibrated shader-unit mappings */
  static defaults = {
    size: 55, overlap: 20.6, count: '+4', background: '#232021',
    refraction: 80,        // Figma 0-100  → shader 0..1  (×0.01, then ×0.62 REF_K)
    frost: 4,              // Figma → blur radius = v/55 · 1.334 (v2 fit)
    dispersion: 50,        // Figma 0-100  → 0..1
    depth: 20,             // Figma 0-100  → 0..1
    lightAngle: -45,       // degrees
    lightIntensity: 40,    // percent
    tint: '#232021',
    tintOpacity: 20,       // percent
    /* calibrated-against-screenshot extras (exposed for tuning) */
    magnification: 1.0,    // all enlargement comes from the refraction term
    darkStrength: 0.80,    // 0.20 + 0.80 → body opaque, as measured
    photoOpacity: 1.0,
    rimIntensity: 0.35,
    rimWidth: 0.042,        // subtly thicker hairline; +10.5% vs fitted base
    bias: 0.0,
    fade: 0.0,             // offset from the avatar's geometric edge
    fadeWidth: 0.086,      // sharp transition half-width
    edgeScale: 0.9322,     // visible dia 51.3px inside the 55px bounds
    edgeFadeStart: 0.404,  // frost-blob weight eases off toward the rim…
    edgeFadeAmt: 0.44,     // …by this much (broad export fit)
    bandWidth: 0.18,       // refractive edge band — 18% of the radius
    bandSharp: 0.6,        // band un-frosts to 40% blur at the boundary
    bandBend: 0.10,        // OUTWARD wrap: edge shows compressed just-outside content
    rimResPx: 32,          // rendered radius where the shine reaches full character
    bandResPx: 44,         // rendered radius where the edge band reaches full character
  };

  constructor() {
    super();
    this._shadow = this.attachShadow({ mode: 'open' });
    this._ready = false;
    this._raf = 0;
    this._texLoaded = false;
  }

  /* attribute helpers */
  _num(name, fallback) {
    const v = this.getAttribute(name);
    return v === null || v === '' || isNaN(+v) ? fallback : +v;
  }
  _str(name, fallback) { return this.getAttribute(name) ?? fallback; }

  connectedCallback() {
    const D = GlassAvatar.defaults;

    this._shadow.innerHTML = `<style>${CSS}</style>
      <img class="photo" alt="" draggable="false">
      <div class="lens">
        <canvas></canvas>
        <span class="label"></span>
      </div>`;

    this._img    = this._shadow.querySelector('.photo');
    this._lens   = this._shadow.querySelector('.lens');
    this._canvas = this._shadow.querySelector('canvas');
    this._label  = this._shadow.querySelector('.label');

    /* WebGL2 — one context per instance; straight-alpha output */
    const gl = this._canvas.getContext('webgl2',
      { alpha: true, premultipliedAlpha: false, antialias: true });
    if (!gl) { console.error('<glass-avatar>: WebGL2 unavailable'); return; }
    this._gl = gl;

    this._program = this._buildProgram(gl, VERT, FRAG);
    gl.useProgram(this._program);

    /* fullscreen quad */
    this._vao = gl.createVertexArray();
    gl.bindVertexArray(this._vao);
    this._vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([0,0, 1,0, 0,1, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this._u = {};
    for (const n of ['uTexture','uResolution','uAspect','uAvatarCenter','uAvatarRadius',
      'uTexScale','uRefraction','uMagnification','uFrost','uDispersion',
      'uDepth','uLightDir','uLightIntensity','uTintColor','uTintOpacity',
      'uDarkStrength','uPhotoOpacity','uRimIntensity','uRimWidth','uBias','uFade',
      'uFadeWidth','uEdgeScale','uTexBlur','uEdgeFadeStart','uEdgeFadeAmt',
      'uBandWidth','uBandSharp','uBandBend','uRimResPx','uBandResPx'])
      this._u[n] = gl.getUniformLocation(this._program, n);

    this._texture = gl.createTexture();     /* sharp, cover-cropped square */
    this._texBlur = gl.createTexture();     /* CPU-gaussian-blurred version */
    this._texAspect = 1;
    this._blurSigma = -1;                   /* cached σ of _texBlur, px    */

    /* redraw on element resize + DPR changes */
    this._ro = new ResizeObserver(() => this._layout());
    this._ro.observe(this);
    this._onDpr = () => { this._watchDpr(); this._layout(); };
    this._watchDpr();
    this._onWinResize = () => this._layout();
    addEventListener('resize', this._onWinResize);

    this._ready = true;
    this._layout();
    this._loadImage();

    /* Inter Tight arrives async — re-verify label metrics once loaded */
    document.fonts?.ready.then(() => this._layout());
  }

  disconnectedCallback() {
    /* full GPU + listener cleanup */
    cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    this._dprQuery?.removeEventListener?.('change', this._onDpr);
    removeEventListener('resize', this._onWinResize);
    const gl = this._gl;
    if (gl) {
      gl.deleteTexture(this._texture);
      gl.deleteTexture(this._texBlur);
      gl.deleteBuffer(this._vbo);
      gl.deleteVertexArray(this._vao);
      gl.deleteProgram(this._program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this._ready = false;
  }

  attributeChangedCallback(name) {
    if (!this._ready) return;
    if (name === 'image') this._loadImage();
    else this._layout();
  }

  /* re-arm the devicePixelRatio watcher against the CURRENT dpr */
  _watchDpr() {
    this._dprQuery?.removeEventListener?.('change', this._onDpr);
    this._dprQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    this._dprQuery.addEventListener?.('change', this._onDpr);
  }

  /* ── geometry, DOM sizing, uniforms that depend on layout ──────────── */
  _layout() {
    if (!this._ready) return;
    const D = GlassAvatar.defaults;
    const size    = this._num('size', D.size);
    const overlap = this._num('overlap', D.overlap);
    const pillWidthValue = this._num('pill-width', NaN);
    const isPill = Number.isFinite(pillWidthValue) && pillWidthValue > size;
    const pillWidth = isPill ? pillWidthValue : size;
    /* zoom = magnified preview of the SAME design-size component: all CSS
       px multiply by it, while the effect math stays at design size.    */
    const zoom    = Math.max(this._num('zoom', 1), 0.01);
    const s       = size / D.size;               /* uniform scale factor */
    /* 'overlap' = VISIBLE overlap between the avatar edge and the visible
       glass edge (edgeScale·size). Measured: 20.6px → centre dist 32.5px. */
    const edgeSc  = this._num('edge-scale', D.edgeScale);
    const visR    = size * edgeSc / 2;
    /* clamp: overlap beyond 'concentric' would place the glass left of
       the avatar and produce negative layout — degrade to concentric    */
    const ovl     = Math.min(Math.max(overlap, 0), size / 2 + visR);
    const cDist   = size / 2 + visR - ovl;        /* avatar→glass centres  */
    const total   = size / 2 + cDist + size / 2;  /* box: avatarR..lens box right */

    this.style.width  = (isPill ? pillWidth : total) * zoom + 'px';
    this.style.height = size  * zoom + 'px';

    Object.assign(this._img.style,
      { width: pillWidth * zoom + 'px', height: size * zoom + 'px' });

    const lensX = size / 2 + cDist - size / 2;   /* lens canvas box left  */
    Object.assign(this._lens.style,
      { left: (isPill ? 0 : lensX * zoom) + 'px',
        width: pillWidth * zoom + 'px', height: size * zoom + 'px' });

    /* text — Figma: 15px / 13px, scaled uniformly with the component */
    this._label.textContent = this._str('count', D.count);
    Object.assign(this._label.style, {
      fontSize:   15 * s * zoom + 'px',
      lineHeight: 13 * s * zoom + 'px',
    });

    /* hi-DPI canvas buffer */
    const dpr = Math.max(devicePixelRatio || 1, 1);
    const pxW = Math.max(1, Math.round(pillWidth * zoom * dpr));
    const pxH = Math.max(1, Math.round(size * zoom * dpr));
    if (this._canvas.width !== pxW || this._canvas.height !== pxH) {
      this._canvas.width = pxW;
      this._canvas.height = pxH;
      this._gl.viewport(0, 0, pxW, pxH);
    }

    /* avatar centre, in lens-normalised coords ([-1,1], y-down)
       lens centre  cx = lensX + size/2 ;  avatar centre ax = size/2      */
    /* avatar centre in VISIBLE-lens units (unit disc = visible circle) */
    this._avatarCenter = [ isPill ? 0 : -cDist / visR, 0 ];
    this._avatarRadius = (size / 2) / visR;       /* measured:  1.073 */
    this._aspect = isPill ? pillWidth / size : 1;

    this._requestRender();
  }

  /* ── avatar texture (also drives the visible <img>) ────────────────── */
  _loadImage() {
    const src = this._str('image', '');
    const img = new Image();
    img.crossOrigin = 'anonymous';                /* set BEFORE src */
    img.onload = () => this._useImage(img, src);
    img.onerror = () => {
      console.error(`<glass-avatar>: could not load "${src}" — ` +
        'check the path/CORS headers. Using procedural placeholder portrait.');
      this._useImage(this._placeholder(), null);
    };
    if (src) img.src = src;
    else this._useImage(this._placeholder(), null);
  }

  _useImage(source, srcForImg) {
    /* visible circular avatar */
    if (srcForImg) this._img.src = srcForImg;
    else {
      this._img.src = source.toDataURL ? source.toDataURL() : '';
    }
    /* Bake the cover-crop into a 256×256 square (identical crop to the
       visible object-fit image — uTexScale becomes 1,1) and upload it.
       May throw for tainted cross-origin pixels.                        */
    const gl = this._gl;
    try {
      const w = source.naturalWidth  || source.width;
      const h = source.naturalHeight || source.height;
      const S = 256;
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const x = c.getContext('2d');
      const sc = Math.max(S / w, S / h);           /* object-fit: cover */
      x.drawImage(source, (S - w * sc) / 2, (S - h * sc) / 2, w * sc, h * sc);
      /* CRITICAL: mask to the inscribed circle. The refraction must see
         darkness beyond the avatar's disc (like Figma's backdrop), NOT
         the photo's square corners — unmasked corners leak bright pixels
         into the boundary ring ("white shade in the corners").          */
      x.globalCompositeOperation = 'destination-in';
      x.beginPath();
      x.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
      x.fill();
      x.globalCompositeOperation = 'source-over';
      this._srcCanvas = c;                          /* blur source */

      gl.bindTexture(gl.TEXTURE_2D, this._texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.generateMipmap(gl.TEXTURE_2D);
      this._texAspect = 1;                          /* square: crop baked */
      this._blurSigma = -1;                         /* force blur rebuild */
      this._texLoaded = true;
    } catch (e) {
      console.error('<glass-avatar>: image is CORS-tainted and cannot be a WebGL texture.', e);
      this._useImage(this._placeholder(), null);   /* visible fallback */
      return;
    }
    this._requestRender();
  }

  /* (Re)build uTexBlur: a true CPU gaussian of the cover-cropped square.
     σ follows the frost amount, so attribute/size changes stay correct. */
  _updateBlurTexture(sigmaPx) {
    if (!this._srcCanvas) return;
    if (Math.abs(sigmaPx - this._blurSigma) < 0.25) return;   /* cached */
    const S = this._srcCanvas.width;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d');
    /* pad by edge-extension before blurring so the gaussian doesn't pull
       transparent black in from outside the canvas */
    x.filter = `blur(${Math.max(sigmaPx, 0.1)}px)`;
    x.drawImage(this._srcCanvas, 0, 0);
    x.filter = 'none';
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, this._texBlur);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._blurSigma = sigmaPx;
  }

  /* Warm procedural stand-in portrait (photo fallback ONLY — the glass
     itself is always shader-generated, never an asset). */
  _placeholder() {
    const seed = this._num('seed', 1);
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const x = c.getContext('2d');
    const hueShift = (seed * 37) % 40 - 20;
    /* orange/yellow backdrop like the reference */
    const bg = x.createLinearGradient(0, 0, 256, 256);
    bg.addColorStop(0, `hsl(${42 + hueShift} 85% 55%)`);
    bg.addColorStop(1, `hsl(${18 + hueShift} 75% 45%)`);
    x.fillStyle = bg; x.fillRect(0, 0, 256, 256);
    x.fillStyle = `hsl(${8 + hueShift} 60% 32%)`;             /* red panel */
    x.fillRect(0, 150, 256, 106);
    /* head + hair + shirt in warm skin/brown tones */
    x.fillStyle = `hsl(${24 + hueShift} 55% 68%)`;            /* skin */
    x.beginPath(); x.ellipse(120, 118, 58, 72, 0, 0, 7); x.fill();
    x.fillStyle = `hsl(${20 + hueShift} 45% 26%)`;            /* hair */
    x.beginPath(); x.ellipse(118, 66, 62, 42, 0, Math.PI, 0); x.fill();
    x.fillStyle = 'hsl(220 15% 18%)';                          /* shirt */
    x.beginPath(); x.ellipse(120, 236, 95, 62, 0, Math.PI, 0, true); x.fill();
    return c;
  }

  /* ── render (on demand only — no continuous rAF loop) ──────────────── */
  _requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
  }

  _render() {
    if (!this._ready || !this._gl) return;
    const gl = this._gl, u = this._u, D = GlassAvatar.defaults;

    const hex = (h) => {
      const n = parseInt(h.replace('#',''), 16);
      return [(n>>16 & 255)/255, (n>>8 & 255)/255, (n & 255)/255];
    };

    /* Figma → shader-unit mappings, calibrated numerically vs. export.
       Figma effect values are ABSOLUTE px (frost 4px blurs a 31px chip
       twice as hard, relatively, as a 55px one). 'fx' converts the
       55px-calibrated constants to this instance's design size, so small
       chips get the softer, darker, subtler look the design shows.
       Override with effect-scale="1" for strictly proportional scaling. */
    const size2      = this._num('size', D.size);
    const fxAttr     = this._num('effect-scale', NaN);
    const fx         = isNaN(fxAttr) ? D.size / size2 : fxAttr;
    const refraction = this._num('refraction', D.refraction) * 0.01 * 0.856;
    const frost      = this._num('frost',      D.frost) / D.size * 1.045 * fx;
    const dispersion = this._num('dispersion', D.dispersion) * 0.01;
    const depth      = this._num('depth',      D.depth) * 0.01;
    const angleDeg   = this._num('light-angle', D.lightAngle);
    /* Figma −45° = light from top-left; screen space here is y-down */
    const a = angleDeg * Math.PI / 180;
    const lightDir = [Math.cos(a) * -1, Math.sin(a)];   /* (−.707, −.707) */

    gl.useProgram(this._program);
    gl.bindVertexArray(this._vao);
    /* single fullscreen pass onto a cleared transparent buffer: blending
       must be OFF, otherwise the AA edge ring gets darkened by an extra
       color×alpha multiply (visible as a dark shadow arc where the rim
       light is dimmest — top-right / bottom-left).                      */
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    /* keep the CPU gaussian in sync with the current frost amount:
       σ(px on the 256px square) = blurR · 0.6 · (256/2)                */
    this._updateBlurTexture(frost * 0.6 * 128);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.uniform1i(u.uTexture, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._texBlur);
    gl.uniform1i(u.uTexBlur, 1);

    gl.uniform2f(u.uResolution, this._canvas.width, this._canvas.height);
    gl.uniform1f(u.uAspect, this._aspect || 1);
    gl.uniform2fv(u.uAvatarCenter, this._avatarCenter);
    gl.uniform1f(u.uAvatarRadius, this._avatarRadius);

    /* cover-crop scale — identical crop to the visible object-fit image */
    const ar = this._texAspect;
    const texScale = ar >= 1 ? [1 / ar, 1] : [1, ar];
    gl.uniform2fv(u.uTexScale, texScale);

    gl.uniform1f(u.uRefraction, refraction);
    gl.uniform1f(u.uMagnification, this._num('magnification', D.magnification));
    gl.uniform1f(u.uFrost, frost);
    gl.uniform1f(u.uDispersion, dispersion);
    gl.uniform1f(u.uDepth, depth);
    gl.uniform2fv(u.uLightDir, lightDir);
    gl.uniform1f(u.uLightIntensity, this._num('light-intensity', D.lightIntensity) * 0.01);
    gl.uniform3fv(u.uTintColor, hex(this._str('tint', D.tint)));
    gl.uniform1f(u.uTintOpacity, this._num('tint-opacity', D.tintOpacity) * 0.01);
    gl.uniform1f(u.uDarkStrength, this._num('dark-strength', D.darkStrength));
    gl.uniform1f(u.uPhotoOpacity, this._num('photo-opacity', D.photoOpacity));
    gl.uniform1f(u.uRimIntensity, this._num('rim-intensity', D.rimIntensity));
    gl.uniform1f(u.uRimWidth,
      Math.min(Math.max(this._num('rim-width', D.rimWidth) * fx, 0.008), 0.30));
    gl.uniform1f(u.uBias, this._num('bias', D.bias));
    gl.uniform1f(u.uFade, this._num('fade', D.fade));
    gl.uniform1f(u.uFadeWidth, this._num('fade-width', D.fadeWidth));
    gl.uniform1f(u.uEdgeScale, this._num('edge-scale', D.edgeScale));
    gl.uniform1f(u.uEdgeFadeStart, this._num('edge-fade-start', D.edgeFadeStart));
    gl.uniform1f(u.uEdgeFadeAmt, this._num('edge-fade-amount', D.edgeFadeAmt));
    gl.uniform1f(u.uBandWidth,
      Math.min(this._num('band-width', D.bandWidth) * fx, 0.45));
    gl.uniform1f(u.uBandSharp, this._num('band-sharp', D.bandSharp));
    gl.uniform1f(u.uBandBend, this._num('band-bend', D.bandBend));
    gl.uniform1f(u.uRimResPx,  Math.max(this._num('rim-res-px',  D.rimResPx),  1.0));
    gl.uniform1f(u.uBandResPx, Math.max(this._num('band-res-px', D.bandResPx), 1.0));

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _buildProgram(gl, vsSrc, fsSrc) {
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
        console.error('<glass-avatar> shader:', gl.getShaderInfoLog(sh));
      return sh;
    };
    const p = gl.createProgram();
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs); gl.deleteShader(fs);   /* program keeps binaries */
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      console.error('<glass-avatar> link:', gl.getProgramInfoLog(p));
    return p;
  }
}

customElements.define('glass-avatar', GlassAvatar);

