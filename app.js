/* =========================================================================
   Dhurta Connection Engine (Offline P2P + Adaptive Dual-Mode WebRTC)
   ========================================================================= */

document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const appLayout = document.getElementById("app-layout");
  const myAvatarEl = document.getElementById("my-avatar");
  const myDisplayNameEl = document.getElementById("my-display-name");
  const netConditionBadge = document.getElementById("net-condition-badge");
  const netQualityText = document.getElementById("net-quality-text");
  const signalGauge = document.querySelector(".signal-gauge");

  const btnOpenSettings = document.getElementById("btn-open-settings");
  const btnCloseSettings = document.getElementById("btn-close-settings");
  const settingsDrawer = document.getElementById("settings-drawer");
  const settingsNameInput = document.getElementById("settings-name-input");
  const settingsAvatarImg = document.getElementById("settings-avatar-img");
  const avatarFileInput = document.getElementById("avatar-file-input");
  const btnSaveSettings = document.getElementById("btn-save-settings");

  const pinInput = document.getElementById("pin-input");
  const activePinText = document.getElementById("active-pin-text");
  const btnJoinPin = document.getElementById("btn-join-pin");
  const btnRandPin = document.getElementById("btn-rand-pin");
  const btnResyncRoom = document.getElementById("btn-resync-room");

  const btnOpenScanner = document.getElementById("btn-open-scanner");
  const btnCloseCam = document.getElementById("btn-close-cam");
  const cameraModal = document.getElementById("camera-modal");
  const scannerVideo = document.getElementById("scanner-video");

  const btnShowMyQr = document.getElementById("btn-show-my-qr");
  const btnCloseQr = document.getElementById("btn-close-qr");
  const qrDisplayModal = document.getElementById("qr-display-modal");
  const btnScanReturnQr = document.getElementById("btn-scan-return-qr");

  const devicesRoster = document.getElementById("devices-roster");
  const chatHeaderTitle = document.getElementById("chat-header-title");
  const chatHeaderStatus = document.getElementById("chat-header-status");
  const chatMessages = document.getElementById("chat-messages");
  const chatTextInput = document.getElementById("chat-text-input");
  const btnSendMessage = document.getElementById("btn-send-message");
  const btnMobileBack = document.getElementById("btn-mobile-back");
  const fileInputBtn = document.getElementById("file-input-btn");
  const fileDropOverlay = document.getElementById("file-drop-overlay");

  const transferMonitor = document.getElementById("transfer-monitor");
  const transTitle = document.getElementById("trans-title");
  const transPct = document.getElementById("trans-pct");
  const transBar = document.getElementById("trans-bar");
  const transBytes = document.getElementById("trans-bytes");
  const transSpeed = document.getElementById("trans-speed");

  const btnCallVoice = document.getElementById("btn-call-voice");
  const btnCallVideo = document.getElementById("btn-call-video");
  const btnScreenShare = document.getElementById("btn-screen-share");
  const videoStage = document.getElementById("video-stage");
  const screenContainer = document.getElementById("screen-container");
  const localStreamVideo = document.getElementById("local-stream-video");
  const remoteStreamVideo = document.getElementById("remote-stream-video");
  const remoteLaserPointer = document.getElementById("remote-laser-pointer");
  const btnMuteAudio = document.getElementById("btn-mute-audio");
  const btnMuteVideo = document.getElementById("btn-mute-video");
  const btnHangup = document.getElementById("btn-hangup");

  const incomingCallBar = document.getElementById("incoming-call-bar");
  const callerAvatar = document.getElementById("caller-avatar");
  const callerName = document.getElementById("caller-name");
  const btnAcceptCall = document.getElementById("btn-accept-call");
  const btnDeclineCall = document.getElementById("btn-decline-call");

  const lightboxModal = document.getElementById("lightbox-modal");
  const lightboxContent = document.getElementById("lightbox-content");
  const btnCloseLightbox = document.getElementById("btn-close-lightbox");

  // ==================== STATE MANAGEMENT ====================
  const myDeviceId = "dev_" + Math.random().toString(36).substring(2, 9);
  let currentPin = null;
  let mqttClient = null;
  let currentTopic = null;

  let peers = new Map(); // peerId -> { name, avatar, lastSeen, pc, dc, ping }
  let roomChatHistory = [];
  let fileBlobStorage = new Map(); // fileId -> Blob

  // High-Speed WebRTC Setup (Air-Gapped LAN + Fallback STUN)
  const rtcConfig = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };
  const CHUNK_SIZE = 64 * 1024; // 64KB chunks for fast local transfers
  let activeTransfers = new Map();

  // Media
  let localStream = null;
  let activeCallPeer = null;
  let cameraStream = null;
  let scannerInterval = null;

  // 1. Profile Initialization (LocalStorage)
  function loadProfile() {
    let profile = JSON.parse(localStorage.getItem("dhurta_profile") || "null");
    if (!profile) {
      const names = ["Cyber Falcon", "Neon Tiger", "Emerald Wolf", "Solar Fox", "Ruby Hawk"];
      profile = {
        name: names[Math.floor(Math.random() * names.length)],
        avatar: generateDefaultAvatarSvg(),
      };
      localStorage.setItem("dhurta_profile", JSON.stringify(profile));
    }
    return profile;
  }

  function generateDefaultAvatarSvg() {
    const emojis = ["🦊", "🦁", "🐯", "🐼", "🐬", "🦅", "⚡"];
    const char = emojis[Math.floor(Math.random() * emojis.length)];
    return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><circle cx="40" cy="40" r="40" fill="%232a3942"/><text x="50%" y="56%" font-size="36" dominant-baseline="middle" text-anchor="middle">${char}</text></svg>`;
  }

  let myProfile = loadProfile();
  function renderProfile() {
    myAvatarEl.src = myProfile.avatar;
    myDisplayNameEl.textContent = myProfile.name;
    settingsAvatarImg.src = myProfile.avatar;
    settingsNameInput.value = myProfile.name;
  }
  renderProfile();

  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024, s = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + s[i];
  }

  function formatTime(ts) {
    return new Date(ts || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // 2. Room Orchestration & Dual-Signaling (Online Broker + Offline QR)
  function joinRoom(pin) {
    if (!/^\d{4}$/.test(pin)) {
      alert("Please enter a valid 4-digit room code.");
      return;
    }

    currentPin = pin;
    pinInput.value = pin;
    activePinText.textContent = pin;
    chatHeaderTitle.textContent = `Room #${pin}`;

    currentTopic = `dhurta_hotspot_v8/room_${pin}`;
    netConditionBadge.textContent = "● Ready (Hotspot)";
    netQualityText.textContent = "Local Hotspot Mode Active (Data Off)";
    signalGauge.className = "signal-gauge online";

    if (mqttClient) mqttClient.end(true);

    // Attempt broker connect if online; if data is off, gracefully catch and operate in QR mode
    try {
      mqttClient = mqtt.connect("wss://broker.emqx.io:8084/mqtt", {
        clientId: myDeviceId,
        clean: true,
        connectTimeout: 4000,
        reconnectPeriod: 3000,
      });

      mqttClient.on("connect", () => {
        netConditionBadge.textContent = "● Synced";
        mqttClient.subscribe(currentTopic, { qos: 0 }, () => {
          sendSignal({ type: "presence", requestHistory: true });
        });
      });

      mqttClient.on("message", (t, msg) => {
        try {
          const payload = JSON.parse(msg.toString());
          if (payload.senderId === myDeviceId) return;
          handleIncomingSignal(payload);
        } catch (e) {}
      });
    } catch (e) {
      console.log("Offline mode: Using QR camera signaling only.");
    }
  }

  function sendSignal(data) {
    data.senderId = myDeviceId;
    data.senderName = myProfile.name;
    data.senderAvatar = myProfile.avatar;
    data.timestamp = Date.now();

    if (mqttClient && mqttClient.connected && currentTopic) {
      mqttClient.publish(currentTopic, JSON.stringify(data));
    }
  }

  // 3. AIR-GAPPED OFFLINE QR SIGNALING (Camera-to-Camera Handshake)
  async function generateOfflineOfferQR() {
    const peerId = "offline_peer";
    const pc = new RTCPeerConnection(rtcConfig);
    const dc = pc.createDataChannel("dhurtaLAN", { ordered: true });
    bindDataChannel(peerId, dc);
    setupPeerConnection(peerId, pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Wait for local ICE candidates to gather completely for offline self-contained SDP
    await waitForIceGathering(pc);

    // Render dense compressed SDP Offer in QR
    const compactSdp = JSON.stringify({ t: "o", sdp: pc.localDescription });
    renderQrCode("qrcode", compactSdp);

    document.getElementById("qr-modal-heading").textContent = "Step 1: Host Offer QR";
    document.getElementById("qr-modal-caption").textContent = "Device 2: Open Scanner & scan this code.";
    qrDisplayModal.classList.remove("hidden");
  }

  async function handleScannedToken(tokenString) {
    try {
      const data = JSON.parse(tokenString);
      cameraModal.classList.add("hidden");
      stopCameraScanner();

      if (data.t === "o") {
        // Device 2 receives Host Offer -> Generates Answer QR
        const peerId = "offline_peer";
        const pc = new RTCPeerConnection(rtcConfig);
        setupPeerConnection(peerId, pc);

        pc.ondatachannel = (e) => bindDataChannel(peerId, e.channel);

        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForIceGathering(pc);

        const compactAnswer = JSON.stringify({ t: "a", sdp: pc.localDescription });
        renderQrCode("qrcode", compactAnswer);

        document.getElementById("qr-modal-heading").textContent = "Step 2: Answer QR";
        document.getElementById("qr-modal-caption").textContent = "Device 1: Scan this code to seal connection!";
        qrDisplayModal.classList.remove("hidden");
      } else if (data.t === "a") {
        // Device 1 receives Answer -> Connected!
        const p = peers.get("offline_peer");
        if (p && p.pc) {
          await p.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          qrDisplayModal.classList.add("hidden");
          alert("Offline Hotspot P2P Connected Successfully!");
        }
      }
    } catch (e) {
      alert("Invalid QR format. Please scan the Dhurta connection QR.");
    }
  }

  function waitForIceGathering(pc) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") {
        resolve();
      } else {
        const check = () => {
          if (pc.iceGatheringState === "complete") {
            pc.removeEventListener("icegatheringstatechange", check);
            resolve();
          }
        };
        pc.addEventListener("icegatheringstatechange", check);
        setTimeout(resolve, 2000); // 2s safety timeout
      }
    });
  }

  function renderQrCode(elementId, text) {
    const box = document.getElementById(elementId);
    box.innerHTML = "";
    new QRCode(box, {
      text: text,
      width: 200,
      height: 200,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.L,
    });
  }

  // Camera Scanner using Native BarcodeDetector or Canvas Fallback
  async function startCameraScanner() {
    cameraModal.classList.remove("hidden");
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      scannerVideo.srcObject = cameraStream;

      if ("BarcodeDetector" in window) {
        const detector = new BarcodeDetector({ formats: ["qr_code"] });
        scannerInterval = setInterval(async () => {
          try {
            const barcodes = await detector.detect(scannerVideo);
            if (barcodes.length > 0) {
              handleScannedToken(barcodes[0].rawValue);
            }
          } catch (e) {}
        }, 200);
      } else {
        // Fallback prompt if BarcodeDetector API is not supported on older browsers
        setTimeout(() => {
          const manualCode = prompt("Paste connection token if camera auto-detect is unsupported:");
          if (manualCode) handleScannedToken(manualCode);
        }, 1000);
      }
    } catch (e) {
      alert("Camera permission denied or camera unavailable.");
      cameraModal.classList.add("hidden");
    }
  }

  function stopCameraScanner() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      cameraStream = null;
    }
    if (scannerInterval) clearInterval(scannerInterval);
  }

  // 4. WebRTC Connection Setup & Handshake
  function setupPeerConnection(peerId, pc) {
    peers.set(peerId, {
      name: "Remote Peer",
      avatar: generateDefaultAvatarSvg(),
      lastSeen: Date.now(),
      pc,
      dc: null,
    });

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal({ type: "ice", targetId: peerId, candidate: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      remoteStreamVideo.srcObject = e.streams[0];
      videoStage.classList.remove("hidden");
    };

    updateRoster();
  }

  function bindDataChannel(peerId, dc) {
    dc.binaryType = "arraybuffer";
    const p = peers.get(peerId);
    if (p) p.dc = dc;

    dc.onopen = () => {
      netConditionBadge.textContent = "● P2P Turbo (Hotspot)";
      netConditionBadge.style.color = "var(--wa-green)";
      signalGauge.className = "signal-gauge online";
      updateRoster();

      // Handshake with profile info
      dc.send(JSON.stringify({ type: "peer_profile", profile: myProfile }));
    };

    dc.onmessage = (e) => {
      handleIncomingDataPacket(e.data, peerId);
    };
  }

  // 5. High-Throughput Heavy Data Streaming (Zero-Stuck Guarantee)
  async function streamHeavyFile(file) {
    const fileId = `file_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const totalBytes = file.size;
    fileBlobStorage.set(fileId, file);

    // Render WhatsApp Outgoing File Card
    appendMessage(myProfile.name, `Shared file: ${file.name}`, true, {
      fileId,
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
    });

    // Notify peers via DataChannel
    broadcastData({
      type: "file_header",
      fileId,
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
    });

    // Monitor UI
    transferMonitor.classList.remove("hidden");
    transTitle.textContent = `Streaming: ${file.name}`;
    let offset = 0;
    const startTime = Date.now();

    for (const [peerId, p] of peers.entries()) {
      if (p.dc && p.dc.readyState === "open") {
        while (offset < totalBytes) {
          const slice = file.slice(offset, offset + CHUNK_SIZE);
          const buf = await slice.arrayBuffer();

          // Flow control backpressure drain
          if (p.dc.bufferedAmount > 256 * 1024) {
            await new Promise((r) => setTimeout(r, 20));
          }

          p.dc.send(buf);
          offset += buf.byteLength;

          const pct = Math.min(100, Math.round((offset / totalBytes) * 100));
          transBar.style.width = `${pct}%`;
          transPct.textContent = `${pct}%`;
          transBytes.textContent = `${formatBytes(offset)} / ${formatBytes(totalBytes)}`;

          const elapsed = (Date.now() - startTime) / 1000;
          if (elapsed > 0.2) {
            transSpeed.textContent = `${formatBytes(offset / elapsed)}/s`;
          }
        }

        p.dc.send(JSON.stringify({ type: "file_eof", fileId }));
      }
    }

    setTimeout(() => {
      transferMonitor.classList.add("hidden");
      transBar.style.width = "0%";
    }, 600);
  }

  function handleIncomingDataPacket(data, peerId) {
    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "peer_profile") {
          const p = peers.get(peerId);
          if (p) {
            p.name = msg.profile.name;
            p.avatar = msg.profile.avatar;
            updateRoster();
          }
        } else if (msg.type === "chat") {
          appendMessage(msg.author, msg.text, false, msg.fileMeta);
        } else if (msg.type === "file_header") {
          activeTransfers.set(msg.fileId, {
            meta: msg,
            chunks: [],
            receivedBytes: 0,
            startTime: Date.now(),
          });
          transferMonitor.classList.remove("hidden");
          transTitle.textContent = `Downloading: ${msg.name}`;

          // Create Incoming File Bubble with Manual Download Button
          appendMessage(peers.get(peerId)?.name || "Remote", `Sent: ${msg.name}`, false, msg);
        } else if (msg.type === "file_eof") {
          const rec = activeTransfers.get(msg.fileId);
          if (rec) {
            const finalBlob = new Blob(rec.chunks, { type: rec.meta.mime });
            fileBlobStorage.set(msg.fileId, finalBlob);

            transferMonitor.classList.add("hidden");
            transBar.style.width = "0%";
            activeTransfers.delete(msg.fileId);

            // Enable download button in message bubble
            enableDownloadButton(msg.fileId);
          }
        } else if (msg.type === "pointer_move") {
          showRemoteLaserPointer(msg.x, msg.y);
        }
      } catch (e) {}
    } else {
      // Binary raw chunk: associate with active transfer
      const activeEntry = [...activeTransfers.values()][0];
      if (activeEntry) {
        activeEntry.chunks.push(data);
        activeEntry.receivedBytes += data.byteLength;

        const total = activeEntry.meta.size;
        const pct = Math.min(100, Math.round((activeEntry.receivedBytes / total) * 100));
        transBar.style.width = `${pct}%`;
        transPct.textContent = `${pct}%`;
        transBytes.textContent = `${formatBytes(activeEntry.receivedBytes)} / ${formatBytes(total)}`;

        const elapsed = (Date.now() - activeEntry.startTime) / 1000;
        if (elapsed > 0.2) {
          transSpeed.textContent = `${formatBytes(activeEntry.receivedBytes / elapsed)}/s`;
        }
      }
    }
  }

  function broadcastData(obj) {
    const str = JSON.stringify(obj);
    peers.forEach((p) => {
      if (p.dc && p.dc.readyState === "open") p.dc.send(str);
    });
  }

  // 6. WhatsApp UI Messages & Manual Download Handling
  function appendMessage(author, text, isMine, fileMeta = null) {
    const bubble = document.createElement("div");
    bubble.className = `wa-bubble ${isMine ? "outgoing" : "incoming"}`;

    let html = "";
    if (!isMine) html += `<div class="bubble-author">${author}</div>`;
    html += `<div>${text}</div>`;

    if (fileMeta) {
      html += `
        <div class="wa-file-card" id="card_${fileMeta.fileId}">
          <svg class="svg-icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <div class="file-info">
            <div class="file-name">${fileMeta.name}</div>
            <div class="file-size">${formatBytes(fileMeta.size)}</div>
          </div>
          <button class="btn-download-pill" id="dlbtn_${fileMeta.fileId}" onclick="window.downloadFile('${fileMeta.fileId}', '${fileMeta.name}')">
            ⬇ Download
          </button>
        </div>
      `;
    }

    html += `
      <div class="bubble-time-row">
        <span>${formatTime()}</span>
        ${isMine ? '<span class="ticks">✓✓</span>' : ""}
      </div>
    `;

    bubble.innerHTML = html;
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function enableDownloadButton(fileId) {
    const btn = document.getElementById(`dlbtn_${fileId}`);
    if (btn) {
      btn.style.background = "#2563eb";
      btn.textContent = "💾 Save";
    }
  }

  // Receiver-controlled manual download
  window.downloadFile = (fileId, fileName) => {
    const blob = fileBlobStorage.get(fileId);
    if (!blob) {
      alert("This file is still downloading over the local network. Please wait a moment.");
      return;
    }

    const url = URL.createObjectURL(blob);

    // Media preview if image
    if (blob.type.startsWith("image/")) {
      lightboxContent.innerHTML = `<img src="${url}" alt="${fileName}" />`;
      lightboxModal.classList.remove("hidden");
    }

    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // 7. Interactive Screen Sharing & Laser Pointer Control
  btnScreenShare.addEventListener("click", async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: "always" },
        audio: true,
      });

      localStreamVideo.srcObject = screenStream;
      videoStage.classList.remove("hidden");

      peers.forEach((p) => {
        if (p.pc) {
          screenStream.getTracks().forEach((track) => p.pc.addTrack(track, screenStream));
        }
      });

      // Track cursor position to broadcast as remote laser pointer
      screenContainer.addEventListener("mousemove", (e) => {
        const rect = screenContainer.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        broadcastData({ type: "pointer_move", x, y });
      });
    } catch (e) {
      alert("Screen sharing canceled or unsupported on this device.");
    }
  });

  function showRemoteLaserPointer(relX, relY) {
    remoteLaserPointer.classList.remove("hidden");
    remoteLaserPointer.style.left = `${relX * 100}%`;
    remoteLaserPointer.style.top = `${relY * 100}%`;
  }

  // 8. Voice & Video Calls (With Camera-Busy Fallback)
  async function triggerCall(videoRequested) {
    if (peers.size === 0) {
      alert("No other device in room yet. Connect with another device first.");
      return;
    }

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: videoRequested,
        audio: true,
      });
    } catch (err) {
      // Fallback: If camera is locked by another window, switch to audio
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    }

    localStreamVideo.srcObject = localStream;
    videoStage.classList.remove("hidden");

    peers.forEach((p) => {
      if (p.pc) {
        localStream.getTracks().forEach((track) => p.pc.addTrack(track, localStream));
      }
    });

    sendSignal({
      type: "call_invite",
      callerName: myProfile.name,
      callerAvatar: myProfile.avatar,
    });
  }

  btnCallVoice.addEventListener("click", () => triggerCall(false));
  btnCallVideo.addEventListener("click", () => triggerCall(true));

  btnHangup.addEventListener("click", () => {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    videoStage.classList.add("hidden");
  });

  btnMuteAudio.addEventListener("click", () => {
    if (!localStream) return;
    const a = localStream.getAudioTracks()[0];
    if (a) {
      a.enabled = !a.enabled;
      btnMuteAudio.style.background = a.enabled ? "#2a3942" : "var(--wa-danger)";
    }
  });

  btnMuteVideo.addEventListener("click", () => {
    if (!localStream) return;
    const v = localStream.getVideoTracks()[0];
    if (v) {
      v.enabled = !v.enabled;
      btnMuteVideo.style.background = v.enabled ? "#2a3942" : "var(--wa-danger)";
    }
  });

  // 9. Roster Update & Mobile Back Navigation
  function updateRoster() {
    devicesRoster.innerHTML = "";
    chatHeaderStatus.textContent = `${peers.size + 1} devices in session`;

    // Self Entry
    const selfRow = document.createElement("div");
    selfRow.className = "roster-card active";
    selfRow.innerHTML = `
      <img src="${myProfile.avatar}" class="avatar-sm" />
      <div class="roster-meta">
        <div class="roster-meta-top">
          <strong>${myProfile.name} (You)</strong>
          <span>Online</span>
        </div>
        <div class="roster-meta-sub">Active Device • Hotspot Core</div>
      </div>
    `;
    devicesRoster.appendChild(selfRow);

    // Remote peers
    peers.forEach((p) => {
      const row = document.createElement("div");
      row.className = "roster-card";
      row.innerHTML = `
        <img src="${p.avatar}" class="avatar-sm" />
        <div class="roster-meta">
          <div class="roster-meta-top">
            <strong>${p.name}</strong>
            <span>P2P Hotspot</span>
          </div>
          <div class="roster-meta-sub">Tap to chat and stream files</div>
        </div>
      `;
      row.onclick = () => {
        // Mobile view transition
        appLayout.classList.add("mobile-chat-active");
      };
      devicesRoster.appendChild(row);
    });
  }

  // Mobile Back Button
  btnMobileBack.addEventListener("click", () => {
    appLayout.classList.remove("mobile-chat-active");
  });

  // Text Chat
  function handleSendMessage() {
    const text = chatTextInput.value.trim();
    if (!text) return;

    appendMessage(myProfile.name, text, true);
    broadcastData({ type: "chat", author: myProfile.name, text });
    chatTextInput.value = "";
  }

  btnSendMessage.addEventListener("click", handleSendMessage);
  chatTextInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") handleSendMessage();
  });

  // Drag and Drop Files
  ["dragenter", "dragover"].forEach((e) => {
    window.addEventListener(e, (ev) => {
      ev.preventDefault();
      fileDropOverlay.classList.remove("hidden");
    });
  });

  ["dragleave", "drop"].forEach((e) => {
    fileDropOverlay.addEventListener(e, (ev) => {
      ev.preventDefault();
      fileDropOverlay.classList.add("hidden");
    });
  });

  fileDropOverlay.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) {
      Array.from(e.dataTransfer.files).forEach((f) => streamHeavyFile(f));
    }
  });

  fileInputBtn.addEventListener("change", (e) => {
    if (e.target.files.length) {
      Array.from(e.target.files).forEach((f) => streamHeavyFile(f));
    }
  });

  // Modals & Navigation
  btnOpenScanner.addEventListener("click", startCameraScanner);
  btnCloseCam.addEventListener("click", () => {
    cameraModal.classList.add("hidden");
    stopCameraScanner();
  });

  btnShowMyQr.addEventListener("click", generateOfflineOfferQR);
  btnScanReturnQr.addEventListener("click", () => {
    qrDisplayModal.classList.add("hidden");
    startCameraScanner();
  });
  btnCloseQr.addEventListener("click", () => qrDisplayModal.classList.add("hidden"));

  btnOpenSettings.addEventListener("click", () => settingsDrawer.classList.remove("hidden"));
  btnCloseSettings.addEventListener("click", () => settingsDrawer.classList.add("hidden"));

  btnSaveSettings.addEventListener("click", () => {
    myProfile.name = settingsNameInput.value.trim() || myProfile.name;
    localStorage.setItem("dhurta_profile", JSON.stringify(myProfile));
    renderProfile();
    settingsDrawer.classList.add("hidden");
  });

  avatarFileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        myProfile.avatar = ev.target.result;
        renderProfile();
      };
      reader.readAsDataURL(file);
    }
  });

  btnCloseLightbox.addEventListener("click", () => lightboxModal.classList.add("hidden"));

  btnJoinPin.addEventListener("click", () => joinRoom(pinInput.value.trim()));
  btnRandPin.addEventListener("click", () => joinRoom(Math.floor(1000 + Math.random() * 9000).toString()));
  btnResyncRoom.addEventListener("click", () => joinRoom(currentPin));

  // Service Worker Registration for PWA Offline Caching
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Bootstrap with default room or URL ?pin=XXXX
  const urlPin = new URLSearchParams(window.location.search).get("pin");
  joinRoom(urlPin && /^\d{4}$/.test(urlPin) ? urlPin : Math.floor(1000 + Math.random() * 9000).toString());
});