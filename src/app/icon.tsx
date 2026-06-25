import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #15B7AE, #34568a)",
          color: "white",
          fontSize: 340,
          fontWeight: 800,
        }}
      >
        P
      </div>
    ),
    { ...size }
  );
}
