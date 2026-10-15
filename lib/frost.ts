// A frosted copy of a camera track. Every frame is shrunk to a few dozen
// pixels and scaled back up, so only colour and rough shapes survive — no
// face, no body detail. It's built from a canvas on *this* device, so until
// both people choose to reveal, the clear camera image never leaves it.

const DETAIL_PX = 28; // horizontal pixels of information that survive
const OUT_WIDTH = 320;
const FPS = 15;

export class FrostedVideo {
  readonly track: MediaStreamTrack;
  private readonly video: HTMLVideoElement;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(camera: MediaStreamTrack) {
    const { width = 640, height = 480 } = camera.getSettings();
    const aspect = height / width;

    const small = document.createElement("canvas");
    small.width = DETAIL_PX;
    small.height = Math.max(1, Math.round(DETAIL_PX * aspect));
    const out = document.createElement("canvas");
    out.width = OUT_WIDTH;
    out.height = Math.round(OUT_WIDTH * aspect);
    const smallCtx = small.getContext("2d")!;
    const outCtx = out.getContext("2d")!;
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = "high";

    // Some browsers only decode video that's in the document; keep it
    // invisible and out of the way.
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute("aria-hidden", "true");
    Object.assign(this.video.style, {
      position: "fixed",
      width: "1px",
      height: "1px",
      opacity: "0",
      pointerEvents: "none",
    });
    document.body.appendChild(this.video);
    this.video.srcObject = new MediaStream([camera]);
    void this.video.play().catch(() => {});

    // Never start on an empty frame.
    outCtx.fillStyle = "#0b0e17";
    outCtx.fillRect(0, 0, out.width, out.height);

    this.timer = setInterval(() => {
      if (this.video.readyState < 2) return;
      smallCtx.drawImage(this.video, 0, 0, small.width, small.height);
      outCtx.drawImage(small, 0, 0, out.width, out.height);
    }, 1000 / FPS);

    this.track = out.captureStream(FPS).getVideoTracks()[0];
  }

  stop() {
    clearInterval(this.timer);
    this.track.stop();
    this.video.srcObject = null;
    this.video.remove();
  }
}
