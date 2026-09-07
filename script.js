document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const myAvatarEl = document.getElementById("my-avatar");
  const myNameEl = document.getElementById("my-assigned-name");
  const connectionStatusDot = document.getElementById("connection-status-dot");
  const activePinDisplay = document.getElementById("active-pin-display");
  const pinInput = document.getElementById("pin-input");
  const enterPinBtn = document.getElementById("btn-enter-pin");
  const randomPinBtn = document.getElementById("btn-random-pin");
  const shareLinkInput = document.getElementById("share-link");
  const copyLinkBtn = document.getElementById("btn-copy-link");
  const showQrBtn = document.getElementById("btn-show-qr");
  const refreshRoomBtn = document.getElementById("btn-refresh-room");
  const newWindowBtn = document.getElementById("btn-new-window");
  const devicesRoster = document.getElementById("devices-roster");

  const chatRoomTitle = document.getElementById("chat-room-title");
  const chatParticipantsCount = document.getElementById("chat-participants-count");
  const chatStream = document.getElementById("chat-stream");
  const chatInput = document.getElementById("chat-input");
  const sendMsgBtn = document.getElementById("btn-send-msg");
  const filePicker = document.getElementById("file-picker");
  const dropOverlay = document.getElementById("drop-overlay");

  const transferTray = document.getElementById("transfer-tray");
  const trayFilename = document.getElementById("tray-filename");
  const trayPercent = document.getElementById("tray-percent");
  const trayBarFill = document.getElementById("tray-bar-fill");
  const traySpeedText = document.getElementById("tray-speed-text");

  // Call & Modal Elements
  const callVideoBtn = document.getElementById("btn-call-video");
  const callAudioBtn = document.getElementById("btn-call-audio");
  const recordSessionBtn = document.getElementById("btn-record-session");
  const videoDock = document.getElementById("video-dock");
  const localVideo = document.getElementById("local-video");
  const remoteVideo = document.getElementById("remote-video");
  const btnMuteMic = document.getElementById("btn-mute-mic");
  const btnToggleCam = document.getElementById("btn-toggle-cam");
  const btnHangup = document.getElementById("btn-hangup");

  const incomingCallModal = document.getElementById("incoming-call-modal");
  const callCallerName = document.getElementById("call-caller-name");
  const callCallerAvatar = document.getElementById("call-caller-avatar");
  const btnAcceptCall = document.getElementById("btn-accept-call");
  const btnRejectCall = document.getElementById("btn-reject-call");

  const qrModal = document.getElementById("qr-modal");
  const qrModalPin = document.getElementById("qr-modal-pin");
  const btnCloseQr = document.getElementById("btn-close-qr");

  // Identity
  const myDeviceId = "wa_dev_" + Math.random().toString(36).substring(2, 9);
  function getWhatsAppProfile() {
    let profile = JSON.parse(sessionStorage.getItem("dhurta_wa_profile") || "null");
    if (!profile) {
      const avatars = ["🦊", "🦁", "🐯", "🐼", "🐬", "🦅", "🐺", "⚡", "🚀", "🪐"];
      const names = ["Cyber Falcon", "Neon Tiger", "Emerald Wolf", "Solar Fox", "Ruby Hawk", "Amber Lynx", "Shadow Eagle", "Aqua Dolphin"];
      profile = {
        name: names[Math.floor(Math.random() * names.length)],
        avatar: avatars[Math.floor(Math.random() * avatars.length)],
      };
      sessionStorage.setItem("dhurta_wa_profile", JSON.stringify(profile));
    }
    return profile;
  }
  const myProfile = getWhatsAppProfile();
  myAvatarEl.textContent = myProfile.avatar;
  myNameEl.textContent = myProfile.name;

  // State
  let currentPin = null;
  let mqttClient = null;
  let currentTopic = null;
  let peers = new Map(); // peerId -> { name, avatar, lastSeen, pc, dc }
  let roomMessages = []; // Persistent history
  let locallyStoredBlobs = new Map(); // fileId -> Blob

  // Adaptive Chunk Engine (32KB chunks + 12ms pacing prevents broker drops)
  const CHUNK_SIZE = 32 * 1024;
  let activeTransfers = new Map(); // fileId -> { meta, chunks, receivedBytes, totalBytes, startTime }

  // Audio/Video Calls
  let localStream = null;
  let activeCallPeer = null;
  let ringtoneInterval = null;
  let mediaRecorder = null;
  let recordedChunks = [];

  const rtcServers = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
    ],
  };

  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024, s = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + s[i];
  }

  function formatTime(timestamp) {
    const d = new Date(timestamp || Date.now());
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // Ringtone synthesizer (no external audio files needed)
  function playRingtone() {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      function beep() {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.frequency.setValueAtTime(440, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.4);
      }
      beep();
      ringtoneInterval = setInterval(beep, 1600);
    } catch (e) {}
  }

  function stopRingtone() {
    if (ringtoneInterval) {
      clearInterval(ringtoneInterval);
      ringtoneInterval = null;
    }
  }

  // 1. Room Orchestration & Real-Time Sync
  function enterRoom(pin) {
    if (!/^\d{4}$/.test(pin)) {
      alert("Please enter a 4-digit code (e.g. 4829)");
      return;
    }

    currentPin = pin;
    pinInput.value = pin;
    activePinDisplay.textContent = pin;
    qrModalPin.textContent = pin;
    chatRoomTitle.textContent = `Dhurta Room #${pin}`;

    const linkUrl = `${window.location.origin}${window.location.pathname}?pin=${pin}`;
    shareLinkInput.value = linkUrl;
    renderQR(linkUrl);

    currentTopic = `dhurta_wa_v7/room_${pin}`;
    connectionStatusDot.textContent = `● Room #${pin}`;
    connectionStatusDot.style.color = "var(--wa-green)";

    if (mqttClient) mqttClient.end(true);

    peers.clear();
    updateRoster();

    // High performance WebSocket MQTT client
    mqttClient = mqtt.connect("wss://broker.emqx.io:8084/mqtt", {
      clientId: myDeviceId,
      clean: true,
      connectTimeout: 7000,
      reconnectPeriod: 2000,
    });

    mqttClient.on("connect", () => {
      mqttClient.subscribe(currentTopic, { qos: 0 }, (err) => {
        if (!err) {
          // Announce with history sync request
          publish({ type: "presence", requestHistory: true });
        }
      });
    });

    mqttClient.on("message", (t, msg) => {
      try {
        const payload = JSON.parse(msg.toString());
        if (payload.senderId === myDeviceId) return; // skip self
        handleIncomingPacket(payload);
      } catch (e) {
        console.error("Payload error:", e);
      }
    });

    mqttClient.on("close", () => {
      connectionStatusDot.textContent = "● Reconnecting";
      connectionStatusDot.style.color = "var(--wa-danger)";
    });
  }

  function publish(data) {
    if (!mqttClient || !mqttClient.connected || !currentTopic) return;
    data.senderId = myDeviceId;
    data.senderName = myProfile.name;
    data.senderAvatar = myProfile.avatar;
    data.timestamp = Date.now();
    mqttClient.publish(currentTopic, JSON.stringify(data));
  }

  // Periodic heartbeat keeps peers connected
  setInterval(() => {
    if (mqttClient && mqttClient.connected) {
      publish({ type: "heartbeat" });

      const now = Date.now();
      let changed = false;
      peers.forEach((val, pId) => {
        if (now - val.lastSeen > 8000) {
          if (val.pc) val.pc.close();
          peers.delete(pId);
          changed = true;
        }
      });
      if (changed) updateRoster();
    }
  }, 2500);

  function renderQR(url) {
    const qEl = document.getElementById("qrcode");
    qEl.innerHTML = "";
    new QRCode(qEl, {
      text: url,
      width: 170,
      height: 170,
      colorDark: "#0b141a",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  // 2. Incoming Packet Dispatcher
  function handleIncomingPacket(msg) {
    // Roster presence check
    const isNew = !peers.has(msg.senderId);
    let p = peers.get(msg.senderId) || {
      name: msg.senderName,
      avatar: msg.senderAvatar || "👤",
      lastSeen: Date.now(),
    };
    p.lastSeen = Date.now();
    p.name = msg.senderName;
    peers.set(msg.senderId, p);

    if (isNew) {
      updateRoster();
      // Transmit previous chat/data history to newcomer
      if (roomMessages.length > 0 && msg.requestHistory) {
        publish({
          type: "history_packet",
          targetId: msg.senderId,
          history: roomMessages,
        });
      }
    }

    if (msg.targetId && msg.targetId !== myDeviceId) return;

    if (msg.type === "history_packet") {
      msg.history.forEach((m) => {
        if (!roomMessages.some((existing) => existing.id === m.id)) {
          appendMessageBubble(m.author, m.avatar, m.text, false, m.fileMeta, m.id, m.timestamp);
        }
      });
    } else if (msg.type === "chat") {
      appendMessageBubble(msg.senderName, msg.senderAvatar, msg.text, false, msg.fileMeta, msg.id, msg.timestamp);
    } else if (msg.type === "stream_chunk") {
      processStreamChunk(msg);
    } else if (msg.type === "call_invite") {
      handleIncomingCallInvite(msg);
    } else if (msg.type === "call_signal") {
      handleCallSignal(msg);
    } else if (msg.type === "call_hangup") {
      endCallLocally();
    }
  }

  function updateRoster() {
    devicesRoster.innerHTML = "";
    const totalCount = peers.size + 1;
    chatParticipantsCount.textContent = `${totalCount} participants in room`;

    // Self Item
    const selfItem = document.createElement("div");
    selfItem.className = "wa-chat-item active";
    selfItem.innerHTML = `
      <div class="avatar">${myProfile.avatar}</div>
      <div class="wa-chat-details">
        <div class="wa-chat-top">
          <span class="wa-chat-title">${myProfile.name} (You)</span>
          <span class="wa-chat-time">Online</span>
        </div>
        <div class="wa-chat-bottom">Current Active Device</div>
      </div>
    `;
    devicesRoster.appendChild(selfItem);

    // Remote Peers
    peers.forEach((peer) => {
      const item = document.createElement("div");
      item.className = "wa-chat-item";
      item.innerHTML = `
        <div class="avatar">${peer.avatar}</div>
        <div class="wa-chat-details">
          <div class="wa-chat-top">
            <span class="wa-chat-title">${peer.name}</span>
            <span class="wa-chat-time" style="color:var(--wa-green)">Synced</span>
          </div>
          <div class="wa-chat-bottom">Ready for heavy file transfer & calls</div>
        </div>
      `;
      devicesRoster.appendChild(item);
    });
  }

  // 3. Heavy Data Dual-Streaming Engine (Solves Stuck Transfers)
  function arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  async function broadcastHeavyFile(file) {
    const fileId = `file_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const totalBytes = file.size;
    const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);
    const meta = { fileId, name: file.name, size: file.size, mime: file.type || "application/octet-stream" };

    locallyStoredBlobs.set(fileId, file);

    // Render outgoing bubble in WhatsApp stream
    appendMessageBubble(myProfile.name, myProfile.avatar, `Shared file: ${file.name}`, true, meta, fileId);

    // Broadcast file notice
    publish({
      type: "chat",
      text: `Shared file: ${file.name}`,
      fileMeta: meta,
      id: fileId,
    });

    transferTray.classList.remove("hidden");
    trayFilename.textContent = `Streaming: ${file.name}`;
    const startTime = Date.now();

    // Stream chunks slice-by-slice with 10ms pacing (never exhausts broker memory)
    for (let i = 0; i < totalChunks; i++) {
      const slice = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const buf = await slice.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);

      publish({
        type: "stream_chunk",
        fileId,
        index: i,
        total: totalChunks,
        totalBytes,
        meta,
        data: b64,
      });

      const sentBytes = Math.min(totalBytes, (i + 1) * CHUNK_SIZE);
      const pct = Math.min(100, Math.round((sentBytes / totalBytes) * 100));
      trayBarFill.style.width = `${pct}%`;
      trayPercent.textContent = `${pct}%`;

      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > 0.2) {
        const speed = sentBytes / elapsed;
        traySpeedText.textContent = `${formatBytes(speed)}/s`;
      }

      await new Promise((r) => setTimeout(r, 10));
    }

    setTimeout(() => {
      transferTray.classList.add("hidden");
      trayBarFill.style.width = "0%";
    }, 600);
  }

  function processStreamChunk(msg) {
    let rec = activeTransfers.get(msg.fileId);
    if (!rec) {
      rec = {
        meta: msg.meta,
        chunks: new Array(msg.total),
        receivedBytes: 0,
        totalBytes: msg.totalBytes,
        startTime: Date.now(),
      };
      activeTransfers.set(msg.fileId, rec);
      transferTray.classList.remove("hidden");
      trayFilename.textContent = `Downloading: ${msg.meta.name}`;
    }

    const chunkBuf = base64ToArrayBuffer(msg.data);
    rec.chunks[msg.index] = chunkBuf;
    rec.receivedBytes += chunkBuf.byteLength;

    const pct = Math.min(100, Math.round((rec.receivedBytes / rec.totalBytes) * 100));
    trayBarFill.style.width = `${pct}%`;
    trayPercent.textContent = `${pct}%`;

    const elapsed = (Date.now() - rec.startTime) / 1000;
    if (elapsed > 0.2) {
      const speed = rec.receivedBytes / elapsed;
      traySpeedText.textContent = `${formatBytes(speed)}/s`;
    }

    // Check completion
    const isComplete = rec.chunks.filter(Boolean).length === msg.total;
    if (isComplete) {
      const finalBlob = new Blob(rec.chunks, { type: rec.meta.mime });
      locallyStoredBlobs.set(msg.fileId, finalBlob);

      transferTray.classList.add("hidden");
      trayBarFill.style.width = "0%";
      activeTransfers.delete(msg.fileId);

      // Activate download button in chat
      updateFileBubbleWithBlob(msg.fileId, finalBlob, rec.meta.name);
    }
  }

  // 4. WhatsApp Chat UI & Safe Downloads
  function appendMessageBubble(author, avatar, text, isMine, fileMeta = null, id = null, timestamp = null) {
    const msgId = id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const timeStr = formatTime(timestamp);

    roomMessages.push({ id: msgId, author, avatar, text, isMine, fileMeta, timestamp: timestamp || Date.now() });

    const bubble = document.createElement("div");
    bubble.className = `wa-msg ${isMine ? "outgoing" : "incoming"}`;
    bubble.id = `bubble_${msgId}`;

    let html = "";
    if (!isMine) {
      html += `<div class="wa-msg-author">${avatar} ${author}</div>`;
    }
    html += `<div>${text}</div>`;

    if (fileMeta) {
      html += `
        <div class="wa-file-card" id="filecard_${fileMeta.fileId}">
          <div class="wa-file-icon">📄</div>
          <div class="wa-file-details">
            <div class="wa-file-name">${fileMeta.name}</div>
            <div class="wa-file-size">${formatBytes(fileMeta.size)}</div>
          </div>
          <button class="btn-file-dl" id="dlbtn_${fileMeta.fileId}" onclick="window.saveFileLocally('${fileMeta.fileId}', '${fileMeta.name}')">
            ⬇ Download
          </button>
        </div>
      `;
    }

    html += `
      <div class="wa-msg-meta">
        <span>${timeStr}</span>
        ${isMine ? '<span class="wa-ticks">✓✓</span>' : ""}
      </div>
    `;

    bubble.innerHTML = html;
    chatStream.appendChild(bubble);
    chatStream.scrollTop = chatStream.scrollHeight;
  }

  function updateFileBubbleWithBlob(fileId, blob, name) {
    const dlBtn = document.getElementById(`dlbtn_${fileId}`);
    if (dlBtn) {
      dlBtn.textContent = "💾 Save File";
      dlBtn.style.background = "#2563eb";
    }

    // Media preview if image or video
    const fileCard = document.getElementById(`filecard_${fileId}`);
    if (fileCard && blob.type.startsWith("image/")) {
      const url = URL.createObjectURL(blob);
      const img = document.createElement("img");
      img.src = url;
      img.style.maxWidth = "100%";
      img.style.borderRadius = "6px";
      img.style.marginTop = "6px";
      fileCard.parentElement.appendChild(img);
    }
  }

  // Guaranteed Safe Downloader
  window.saveFileLocally = (fileId, fileName) => {
    const blob = locallyStoredBlobs.get(fileId);
    if (!blob) {
      alert("This file is still downloading or buffering. Please wait a moment.");
      return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  function sendTextMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    const id = `msg_${Date.now()}`;
    appendMessageBubble(myProfile.name, myProfile.avatar, text, true, null, id);
    publish({ type: "chat", text, id });
    chatInput.value = "";
  }

  sendMsgBtn.addEventListener("click", sendTextMessage);
  chatInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendTextMessage();
  });

  // Drag and drop handler
  ["dragenter", "dragover"].forEach((eName) => {
    window.addEventListener(eName, (e) => {
      e.preventDefault();
      dropOverlay.classList.remove("hidden");
    });
  });

  ["dragleave", "drop"].forEach((eName) => {
    dropOverlay.addEventListener(eName, (e) => {
      e.preventDefault();
      dropOverlay.classList.add("hidden");
    });
  });

  dropOverlay.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) {
      Array.from(e.dataTransfer.files).forEach((f) => broadcastHeavyFile(f));
    }
  });

  filePicker.addEventListener("change", (e) => {
    if (e.target.files.length) {
      Array.from(e.target.files).forEach((f) => broadcastHeavyFile(f));
    }
  });

  // 5. Audio / Video Calling Engine (With Dual-Tab Safety Fallback)
  async function acquireMedia(videoRequested = true) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: videoRequested, audio: true });
    } catch (err) {
      // Camera may be locked by another tab on the same PC: fall back to audio
      console.warn("Camera locked or unavailable. Falling back to audio-only.");
      return await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    }
  }

  async function startCall(video = true) {
    if (peers.size === 0) {
      alert("Wait for at least one other device to enter this room before calling.");
      return;
    }

    localStream = await acquireMedia(video);
    localVideo.srcObject = localStream;
    videoDock.classList.remove("hidden");

    activeCallPeer = peers.keys().next().value;

    publish({
      type: "call_invite",
      targetId: activeCallPeer,
      callerName: myProfile.name,
      callerAvatar: myProfile.avatar,
      hasVideo: video,
    });
  }

  callVideoBtn.addEventListener("click", () => startCall(true));
  callAudioBtn.addEventListener("click", () => startCall(false));

  function handleIncomingCallInvite(msg) {
    playRingtone();
    callCallerName.textContent = `${msg.callerName} is calling...`;
    callCallerAvatar.textContent = msg.callerAvatar || "📞";
    incomingCallModal.classList.remove("hidden");

    btnAcceptCall.onclick = async () => {
      stopRingtone();
      incomingCallModal.classList.add("hidden");

      localStream = await acquireMedia(msg.hasVideo);
      localVideo.srcObject = localStream;
      videoDock.classList.remove("hidden");

      activeCallPeer = msg.senderId;
      initiateWebRTCPeerConnection(msg.senderId, false);
      publish({ type: "call_signal", targetId: msg.senderId, sub: "accepted" });
    };

    btnRejectCall.onclick = () => {
      stopRingtone();
      incomingCallModal.classList.add("hidden");
      publish({ type: "call_signal", targetId: msg.senderId, sub: "rejected" });
    };
  }

  function handleCallSignal(msg) {
    if (msg.sub === "accepted") {
      initiateWebRTCPeerConnection(msg.senderId, true);
    } else if (msg.sub === "rejected") {
      alert("Call was declined.");
      endCallLocally();
    } else if (msg.sub === "sdp_offer") {
      handleSdpOffer(msg.senderId, msg.sdp);
    } else if (msg.sub === "sdp_answer") {
      handleSdpAnswer(msg.senderId, msg.sdp);
    } else if (msg.sub === "ice") {
      handleIceCandidate(msg.senderId, msg.candidate);
    }
  }

  let pc = null;
  async function initiateWebRTCPeerConnection(peerId, isOffer) {
    pc = new RTCPeerConnection(rtcServers);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        publish({ type: "call_signal", targetId: peerId, sub: "ice", candidate: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      remoteVideo.srcObject = e.streams[0];
    };

    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }

    if (isOffer) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      publish({ type: "call_signal", targetId: peerId, sub: "sdp_offer", sdp: offer });
    }
  }

  async function handleSdpOffer(senderId, sdp) {
    if (!pc) await initiateWebRTCPeerConnection(senderId, false);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    publish({ type: "call_signal", targetId: senderId, sub: "sdp_answer", sdp: answer });
  }

  async function handleSdpAnswer(senderId, sdp) {
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }

  async function handleIceCandidate(senderId, candidate) {
    if (pc && candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {}
    }
  }

  function endCallLocally() {
    stopRingtone();
    incomingCallModal.classList.add("hidden");
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (pc) {
      pc.close();
      pc = null;
    }
    videoDock.classList.add("hidden");
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
  }

  btnHangup.addEventListener("click", () => {
    if (activeCallPeer) publish({ type: "call_hangup", targetId: activeCallPeer });
    endCallLocally();
  });

  btnMuteMic.addEventListener("click", () => {
    if (!localStream) return;
    const a = localStream.getAudioTracks()[0];
    if (a) {
      a.enabled = !a.enabled;
      btnMuteMic.textContent = a.enabled ? "🎤" : "🔇";
    }
  });

  btnToggleCam.addEventListener("click", () => {
    if (!localStream) return;
    const v = localStream.getVideoTracks()[0];
    if (v) {
      v.enabled = !v.enabled;
      btnToggleCam.textContent = v.enabled ? "📷" : "🚫";
    }
  });

  // Session Recording
  recordSessionBtn.addEventListener("click", async () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      recordSessionBtn.style.color = "inherit";
      return;
    }

    try {
      let stream = localStream;
      if (!stream) {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      }

      recordedChunks = [];
      mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm" });
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
      };
      mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `WhatsApp-Dhurta-Record-${Date.now()}.webm`;
        a.click();
      };
      mediaRecorder.start();
      recordSessionBtn.style.color = "var(--wa-danger)";
    } catch (e) {
      alert("Recording canceled or unsupported.");
    }
  });

  // 6. Navigation & QR Controls
  enterPinBtn.addEventListener("click", () => enterRoom(pinInput.value.trim()));
  randomPinBtn.addEventListener("click", () => {
    enterRoom(Math.floor(1000 + Math.random() * 9000).toString());
  });

  newWindowBtn.addEventListener("click", () => {
    window.open(shareLinkInput.value, "_blank", "width=1000,height=850");
  });

  copyLinkBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(shareLinkInput.value).then(() => {
      copyLinkBtn.textContent = "Copied!";
      setTimeout(() => (copyLinkBtn.textContent = "Copy"), 2000);
    });
  });

  showQrBtn.addEventListener("click", () => qrModal.classList.remove("hidden"));
  btnCloseQr.addEventListener("click", () => qrModal.classList.add("hidden"));

  refreshRoomBtn.addEventListener("click", () => {
    enterRoom(currentPin);
  });

  // Bootstrap with URL query or random 4-digit room
  const urlPin = new URLSearchParams(window.location.search).get("pin");
  if (urlPin && /^\d{4}$/.test(urlPin)) {
    enterRoom(urlPin);
  } else {
    enterRoom(Math.floor(1000 + Math.random() * 9000).toString());
  }
});