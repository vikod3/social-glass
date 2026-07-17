"use client";

import React from "react";
import { createRoot } from "react-dom/client";
import { Glass } from "@samasante/liquid-glass";

// Calibrated from the supplied Figma values:
// Light -45° 80% · Refraction 80 · Depth 20 · Dispersion 50
// Frost 4 · Splay 0
const optics = {
  mapSize: 1024,
  clipToShape: true,
  softEdge: true,
  strength: 0.112,
  depth: 0.2222,
  curvature: 0.3667,
  dispersion: 0.54,
  bend: 0.736,
  bendWidth: 0.1111,
  frost: 4,
  saturate: 1.08,
  brightness: 0,
  specular: 1.08,
  sheenAngle: -45,
  sheen: 0.704,
  sheenWidth: 2,
  sheenFalloff: 2.4,
  glow: 0.128,
  glowSpread: 0.35,
  glowFalloff: 1.25,
  splay: 0,
};

function backdropFor(control, size) {
  const tile = control.closest(".video-tile");
  const photo = tile?.querySelector(":scope > img");

  if (tile && photo) {
    const photoStyle = getComputedStyle(photo);
    return (
      <div style={{ position: "relative", width: size, height: size, overflow: "hidden" }}>
        <img
          src={photo.currentSrc || photo.src}
          alt=""
          style={{
            position: "absolute",
            left: parseFloat(photoStyle.left) - control.offsetLeft,
            top: parseFloat(photoStyle.top) - control.offsetTop,
            width: parseFloat(photoStyle.width),
            height: parseFloat(photoStyle.height),
            maxWidth: "none",
            objectFit: photoStyle.objectFit,
            transform: photoStyle.transform === "none" ? undefined : photoStyle.transform,
            transformOrigin: photoStyle.transformOrigin,
          }}
        />
      </div>
    );
  }

  const color = control.classList.contains("header-button") ? "#E2EAE8" : "#232021";
  return <div style={{ width: size, height: size, background: color }} />;
}

function FigmaGlassSurface({ control, size }) {
  const isHeader = control.classList.contains("header-button");
  const isParticipant = control.classList.contains("participant-status");
  const behind = isHeader ? "#E2EAE8" : "#232021";
  const tint = isHeader
    ? "rgba(255, 255, 255, 0.04)"
    : isParticipant
      ? "rgba(35, 32, 33, 0.08)"
      : "rgba(35, 32, 33, 0.2)";

  return (
    <Glass
      width={size}
      height={size}
      radius={size / 2}
      optics={optics}
      filterResolution={2}
      refract={backdropFor(control, size)}
      behind={behind}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 0,
        overflow: "hidden",
        background: tint,
      }}
    />
  );
}

for (const control of document.querySelectorAll(
  ".header-button, .participant-status, .call-action--glass",
)) {
  const size = control.classList.contains("participant-status") ? 35 : 55;
  const host = document.createElement("span");
  host.className = "liquid-glass-host";
  host.setAttribute("aria-hidden", "true");
  control.prepend(host);
  createRoot(host).render(<FigmaGlassSurface control={control} size={size} />);
}
