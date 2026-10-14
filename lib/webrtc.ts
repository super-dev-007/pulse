export type DescType = "offer" | "answer" | "ice";
const CONTROLS = [
  "video-request",
  "video-accept",
  "video-decline",
  "video-end",
  "typing",
] as const;
export type PeerControl = (typeof CONTROLS)[number];

// The data channel is peer-to-peer, so whatever arrives on it comes straight
// from a stranger's client. Bound it before it reaches the UI.
export const MAX_CHAT_LENGTH = 1_000;
const MAX_FRAME_BYTES = 8 * 1024;
const MAX_MESSAGES_PER_WINDOW = 20; // per INBOUND_WINDOW_MS
const INBOUND_WINDOW_MS = 5_000;

interface PeerCallbacks {
  onSignal: (type: DescType, payload: string) => void;
  onChat: (text: string) => void;
  onControl: (ctrl: PeerControl) => void;
  onRemoteStream: (stream: MediaStream | null) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onChannelOpen: () => void;
  onChannelClose: () => void;
}

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export class PeerSession {
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private readonly polite: boolean;
  private makingOffer = false;
  private ignoreOffer = false;
  private localStream: MediaStream | null = null;
  private closed = false;
  private readonly cb: PeerCallbacks;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private signalChain: Promise<void> = Promise.resolve();
  private inboundAt: number[] = [];

  constructor(initiator: boolean, cb: PeerCallbacks) {
    this.cb = cb;
    this.polite = !initiator;
    this.pc = new RTCPeerConnection(ICE_CONFIG);

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.cb.onSignal("ice", JSON.stringify(candidate));
      }
    };

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        if (this.pc.localDescription) {
          this.cb.onSignal("offer", JSON.stringify(this.pc.localDescription));
        }
      } catch (err) {
        console.warn("[pulse] negotiation failed", err);
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.ontrack = ({ streams }) => {
      this.cb.onRemoteStream(streams[0] ?? null);
    };

    this.pc.onconnectionstatechange = () => {
      this.cb.onConnectionState(this.pc.connectionState);
    };

    if (initiator) {
      this.dc = this.pc.createDataChannel("chat");
      this.wireDataChannel(this.dc);
    } else {
      this.pc.ondatachannel = (e) => {
        this.dc = e.channel;
        this.wireDataChannel(this.dc);
      };
    }
  }

  private wireDataChannel(dc: RTCDataChannel) {
    dc.onopen = () => this.cb.onChannelOpen();
    // The remote side went away (tab closed, peer connection torn down).
    // Ignore the close we trigger ourselves in close().
    dc.onclose = () => {
      if (!this.closed) this.cb.onChannelClose();
    };
    dc.onmessage = (e) => {
      if (typeof e.data !== "string" || e.data.length > MAX_FRAME_BYTES) return;
      if (!this.withinInboundRate()) return;
      try {
        const msg = JSON.parse(e.data);
        if (
          msg.t === "chat" &&
          typeof msg.text === "string" &&
          msg.text.length <= MAX_CHAT_LENGTH
        ) {
          this.cb.onChat(msg.text);
        } else if (msg.t === "ctrl" && CONTROLS.includes(msg.ctrl)) {
          this.cb.onControl(msg.ctrl);
        }
      } catch {}
    };
  }

  // Sliding window over inbound messages: a flooding peer gets dropped
  // instead of freezing the chat.
  private withinInboundRate(): boolean {
    const now = Date.now();
    this.inboundAt = this.inboundAt.filter((t) => now - t < INBOUND_WINDOW_MS);
    if (this.inboundAt.length >= MAX_MESSAGES_PER_WINDOW) return false;
    this.inboundAt.push(now);
    return true;
  }

  // Signals arrive in batches from the poll loop. Handled concurrently, an ICE
  // candidate could overtake the description it belongs to, so apply them
  // strictly in arrival order.
  handleSignal(type: DescType, payload: string): Promise<void> {
    this.signalChain = this.signalChain
      .then(() => this.applySignal(type, payload))
      .catch((err) => console.warn(`[pulse] failed to apply ${type}`, err));
    return this.signalChain;
  }

  private async applySignal(type: DescType, payload: string) {
    if (this.closed) return;
    const data = JSON.parse(payload);

    if (type === "ice") {
      if (!this.pc.remoteDescription) {
        this.pendingCandidates.push(data);
        return;
      }
      try {
        await this.pc.addIceCandidate(data);
      } catch {}
      return;
    }

    const desc = data as RTCSessionDescriptionInit;
    const offerCollision =
      desc.type === "offer" &&
      (this.makingOffer || this.pc.signalingState !== "stable");
    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) return;

    await this.pc.setRemoteDescription(desc);
    // Early candidates can only be applied once a remote description exists;
    // flushing them before setRemoteDescription made every one of them fail.
    await this.flushPendingCandidates();
    if (desc.type === "offer") {
      await this.pc.setLocalDescription();
      if (this.pc.localDescription) {
        this.cb.onSignal("answer", JSON.stringify(this.pc.localDescription));
      }
    }
  }

  private async flushPendingCandidates() {
    if (this.pendingCandidates.length === 0) return;
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {}
    }
  }

  sendChat(text: string) {
    this.safeSend({ t: "chat", text: text.slice(0, MAX_CHAT_LENGTH) });
  }

  sendControl(ctrl: PeerControl) {
    this.safeSend({ t: "ctrl", ctrl });
  }

  private safeSend(obj: unknown) {
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify(obj));
    }
  }

  async startVideo(): Promise<MediaStream> {
    if (!this.localStream) {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      for (const track of this.localStream.getTracks()) {
        this.pc.addTrack(track, this.localStream);
      }
    }
    return this.localStream;
  }

  // Mute without renegotiating: a disabled track sends silence / black.
  setMicEnabled(on: boolean) {
    for (const t of this.localStream?.getAudioTracks() ?? []) t.enabled = on;
  }

  setCameraEnabled(on: boolean) {
    for (const t of this.localStream?.getVideoTracks() ?? []) t.enabled = on;
  }

  stopVideo() {
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) track.stop();
      for (const sender of this.pc.getSenders()) {
        if (sender.track) {
          try {
            this.pc.removeTrack(sender);
          } catch {}
        }
      }
      this.localStream = null;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopVideo();
    if (this.dc) {
      try {
        this.dc.close();
      } catch {}
    }
    try {
      this.pc.close();
    } catch {}
  }
}
