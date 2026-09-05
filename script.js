document.addEventListener("DOMContentLoaded", () => {
  // Elements: Header & Global Controls
  const userAliasSpan = document.getElementById("user-alias");
  const roomStatusBadge = document.getElementById("room-status-badge");
  const roomStatusText = document.getElementById("room-status-text");
  const selfTestBtn = document.getElementById("btn-self-test");
  const diagModal = document.getElementById("diag-modal");
  const diagResults = document.getElementById("diag-results");
  const closeDiagBtn = document.getElementById("btn-close-diag");

  const alertBanner = document.getElementById("alert-banner");
  const alertMessage = document.getElementById("alert-message");
  const alertIcon = document.getElementById("alert-icon");
  const dismissAlertBtn = document.getElementById("btn-dismiss-alert");
  const consoleOutput = document.getElementById("console-output");
  const clearConsoleBtn = document.getElementById("btn-clear-console");

  // Elements: Out-Space
  const outSpace = document.getElementById("out-space");
  const pinInput = document.getElementById("pin-input");
  const enterRoomBtn = document.getElementById("btn-enter-room");
  const randomPinBtn = document.getElementById("btn-random-pin");
  const directLinkInput = document.getElementById("direct-link-input");
  const copyLinkBtn = document.getElementById("btn-copy-link");
  const openWindowBtn = document.getElementById("btn-open-window");
  const qrContainer = document.getElementById("qrcode");

  // Elements: In-Space Workspace
  const inSpace = document.getElementById("in-space");
  const activePinDisplay = document.getElementById("active-pin-display");
  const activeDeviceCount = document.getElementById("active-device-count");
  const leaveRoomBtn = document.getElementById("btn-leave-room");
  const deviceRoster = document.getElementById("device-roster");

  // Call & Record Elements
  const startCallBtn = document.getElementById("btn-start-call");
  const endCallBtn = document.getElementById("btn-end-call");
  const recordSessionBtn = document.getElementById("btn-record-session");
  const callVideoGrid = document.getElementById("call-video-grid");
  const localVideo = document.getElementById("local-video");
  const remoteVideo = document.getElementById("remote-video");
  const recordStatusBar = document.getElementById("record-status-bar");

  // File Transfer Elements
  const dropArea = document.getElementById("drop-area");
  const fileInputEl = document.getElementById("file-input-el");
  const stagedQueue = document.getElementById("staged-queue");
  const dispatchFilesBtn = document.getElementById("btn-dispatch-files");
  const transferProgressBox = document.getElementById("transfer-progress-box");
  const progressBarFill = document.getElementById("progress-bar-fill");
  const progressFileName = document.getElementById("progress-file-name");
  const progressPercentage = document.getElementById("progress-percentage");
  const fileStatusIndicator = document.getElementById("file-status-indicator");

  // Chat Elements
  const chatStream = document.getElementById("chat-stream");
  const chatInputBox = document.getElementById("chat-input-box");
  const sendMessageBtn = document.getElementById("btn-send-message");

  // App State
  let myPeerId = null;
  let activePin = null;
  let mqttClient = null;
  let peer = null;
  let webRtcConn = null;
  let localStream = null;
  let activeCall = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let stagedFiles = [];
  let roomPeers = new Map(); // peerId -> name

  // 1. Generate Consistent Device Alias
  function getDeviceAlias() {
    let name = sessionStorage.getItem("dhurta_device_alias");
    if (!name) {
      const adjectives = ["Cyber", "Neon", "Cosmic", "Solar", "Emerald", "Ruby", "Shadow", "Amber", "Quantum"];
      const nouns = ["Falcon", "Tiger", "Fox", "Wolf", "Hawk", "Eagle", "Cheetah", "Lynx", "Phoenix"];
      name = `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`;
      sessionStorage.setItem("dhurta_device_alias", name);
    }
    return name;
  }
  const myAlias = getDeviceAlias();
  userAliasSpan.textContent = myAlias;

  // Logging & Alert Helpers
  function log(msg, type = "default") {
    const el = document.createElement("div");
    el.className = type;
    el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    consoleOutput.appendChild(el);
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
  }

  function showAlert(msg, isError = true) {
    alertMessage.textContent = msg;
    alertIcon.textContent = isError ? "❌" : "ℹ️";
    alertBanner.className = isError ? "alert-banner" : "alert-banner info";
    alertBanner.classList.remove("hidden");
    log(msg, isError ? "error" : "info");
  }

  dismissAlertBtn.addEventListener("click", () => alertBanner.classList.add("hidden"));
  closeDiagBtn.addEventListener("click", () => diagModal.classList.add("hidden"));
  clearConsoleBtn.addEventListener("click", () => (consoleOutput.innerHTML = ""));

  function formatBytes(b) {
    if (b === 0) return "0 B";
    const k = 1024, s = ["B", "KB", "MB", "GB"], i = Math.floor(Math.log(b) / Math.log(k));
    return parseFloat((b / Math.pow(k, i)).toFixed(1)) + " " + s[i];
  }

  // 2. Client-Side QR Renderer
  function renderQR(url) {
    qrContainer.innerHTML = "";
    new QRCode(qrContainer, {
      text: url,
      width: 170,
      height: 170,
      colorDark: "#090d16",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  // 3. Dual-Engine Connection Initialization
  function enterRoom(pin) {
    if (!/^\d{4}$/.test(pin)) {
      showAlert("Please enter a valid 4-digit code (e.g. 4829).", true);
      return;
    }

    activePin = pin;
    pinInput.value = pin;
    activePinDisplay.textContent = pin;

    // Transition from Out-Space to In-Space
    outSpace.classList.add("hidden");
    inSpace.classList.remove("hidden");

    roomStatusBadge.className = "status-badge online";
    roomStatusText.textContent = `In-Space (Room ${pin})`;
    showAlert(`Entered Room ${pin}. Synchronizing devices...`, false);

    initMqttRoomBus(pin);
    initPeerEngine();
  }

  // Engine A: Real-Time MQTT Room Bus (Signaling + Guaranteed Chat Sync)
  function initMqttRoomBus(pin) {
    if (mqttClient) mqttClient.end();

    log(`Connecting to global room bus for PIN ${pin}...`, "info");
    
    // Connect to public secure WebSocket broker
    mqttClient = mqtt.connect("wss://broker.emqx.io:8084/mqtt", {
      clientId: `dhurta_${Math.random().toString(16).slice(2, 10)}`,
      keepalive: 30,
    });

    mqttClient.on("connect", () => {
      log(`Room bus connected for Room ${pin}.`, "success");
      const roomTopic = `dhurta/v4/room/${pin}/#`;
      mqttClient.subscribe(roomTopic);

      // Announce presence
      announcePresence();
    });

    mqttClient.on("message", (topic, message) => {
      try {
        const data = JSON.parse(message.toString());
        handleRoomBusMessage(topic, data);
      } catch (err) {
        // ignore non-json
      }
    });

    mqttClient.on("error", (err) => {
      log(`Room bus error: ${err.message}`, "error");
    });
  }

  function announcePresence() {
    if (!mqttClient || !activePin) return;
    mqttClient.publish(
      `dhurta/v4/room/${activePin}/presence`,
      JSON.stringify({
        alias: myAlias,
        peerId: myPeerId,
        timestamp: Date.now(),
      })
    );
  }

  function handleRoomBusMessage(topic, data) {
    const action = topic.split("/").pop();

    if (action === "presence") {
      // Ignore self
      if (data.alias === myAlias) return;

      log(`Discovered room member: ${data.alias}`, "success");
      roomPeers.set(data.alias, data.peerId);
      updateRoster();

      // If remote device has a PeerJS ID and we don't have WebRTC yet, initiate connection
      if (data.peerId && peer && !webRtcConn) {
        log(`Initiating WebRTC direct channel to ${data.alias}...`, "info");
        const conn = peer.connect(data.peerId);
        bindWebRtcChannel(conn);
      }
    } else if (action === "chat") {
      if (data.sender !== myAlias) {
        renderChatBubble(data.sender, data.text, false);
      }
    } else if (action === "file") {
      if (data.sender !== myAlias) {
        handleIncomingMqttFile(data);
      }
    }
  }

  // Engine B: WebRTC / PeerJS Direct Link
  function initPeerEngine() {
    if (peer) peer.destroy();

    peer = new Peer({
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun.cloudflare.com:3478" },
        ],
      },
    });

    peer.on("open", (id) => {
      myPeerId = id;
      log(`P2P WebRTC engine ready (ID: ${id.slice(0, 8)}...).`, "success");

      // Build and render direct share link
      const joinUrl = `${window.location.origin}${window.location.pathname}?pin=${activePin}`;
      directLinkInput.value = joinUrl;
      renderQR(joinUrl);

      // Re-announce presence with Peer ID
      announcePresence();
    });

    peer.on("connection", (conn) => {
      log(`Incoming WebRTC direct connection established!`, "success");
      bindWebRtcChannel(conn);
    });

    peer.on("call", (call) => {
      handleIncomingCall(call);
    });

    peer.on("error", (err) => {
      log(`WebRTC warning (${err.type}): falling back to Room Bus.`, "info");
    });
  }

  function bindWebRtcChannel(conn) {
    webRtcConn = conn;

    const setup = () => {
      log(`WebRTC DataChannel confirmed open with peer!`, "success");
      fileStatusIndicator.textContent = "P2P Connected";
      fileStatusIndicator.className = "status-badge online";
    };

    if (conn.open) setup();
    else conn.on("open", setup);

    conn.on("data", (data) => {
      if (typeof data === "string") {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "chat") renderChatBubble(parsed.sender, parsed.text, false);
          if (parsed.type === "file") handleIncomingMqttFile(parsed);
        } catch (e) {}
      }
    });

    conn.on("close", () => {
      webRtcConn = null;
      fileStatusIndicator.textContent = "Room Bus Active";
      fileStatusIndicator.className = "badge-neutral";
    });
  }

  // 4. Device Roster Updates
  function updateRoster() {
    deviceRoster.innerHTML = "";
    const total = roomPeers.size + 1;
    activeDeviceCount.textContent = total;

    // Self
    const selfChip = document.createElement("div");
    selfChip.className = "device-chip";
    selfChip.innerHTML = `<span><span class="dot"></span><strong>${myAlias}</strong> (You)</span><span style="color:#64748b">Host</span>`;
    deviceRoster.appendChild(selfChip);

    // Remote Members
    roomPeers.forEach((pId, name) => {
      const chip = document.createElement("div");
      chip.className = "device-chip";
      chip.innerHTML = `<span><span class="dot"></span>${name}</span><span style="color:#10b981">Synced</span>`;
      deviceRoster.appendChild(chip);
    });
  }

  // 5. Reliable File Transfer & Media Streaming
  function arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
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

  // Drag & Drop
  ["dragenter", "dragover"].forEach((evt) => {
    dropArea.addEventListener(evt, (e) => {
      e.preventDefault();
      dropArea.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((evt) => {
    dropArea.addEventListener(evt, (e) => {
      e.preventDefault();
      dropArea.classList.remove("dragover");
    });
  });

  dropArea.addEventListener("drop", (e) => {
    if (e.dataTransfer.files.length) handleSelectedFiles(e.dataTransfer.files);
  });

  fileInputEl.addEventListener("change", (e) => {
    if (e.target.files.length) handleSelectedFiles(e.target.files);
  });

  function handleSelectedFiles(files) {
    stagedFiles = Array.from(files);
    stagedQueue.innerHTML = "";

    stagedFiles.forEach((file) => {
      const row = document.createElement("div");
      row.className = "staged-row";
      row.innerHTML = `<span>📄 ${file.name}</span><span style="color:#64748b">${formatBytes(file.size)}</span>`;
      stagedQueue.appendChild(row);
    });

    fileStatusIndicator.textContent = `${stagedFiles.length} file(s) staged`;
  }

  // Dispatch Files
  dispatchFilesBtn.addEventListener("click", async () => {
    if (!stagedFiles.length) {
      showAlert("Please drag & drop or select files first.", true);
      return;
    }

    dispatchFilesBtn.disabled = true;
    transferProgressBox.classList.remove("hidden");

    for (const file of stagedFiles) {
      progressFileName.textContent = `Streaming: ${file.name}`;
      progressBarFill.style.width = "30%";
      progressPercentage.textContent = "30%";

      const buffer = await file.arrayBuffer();
      const base64Data = arrayBufferToBase64(buffer);

      const payload = {
        sender: myAlias,
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        data: base64Data,
      };

      progressBarFill.style.width = "80%";
      progressPercentage.textContent = "80%";

      // Send via WebRTC if open, otherwise send via Room Bus (Guarantees delivery)
      if (webRtcConn && webRtcConn.open) {
        webRtcConn.send(JSON.stringify({ type: "file", ...payload }));
      } else if (mqttClient) {
        mqttClient.publish(`dhurta/v4/room/${activePin}/file`, JSON.stringify(payload));
      }

      progressBarFill.style.width = "100%";
      progressPercentage.textContent = "100%";

      renderSentFile(file);
      log(`Transferred file: ${file.name}`, "success");
    }

    setTimeout(() => {
      transferProgressBox.classList.add("hidden");
      progressBarFill.style.width = "0%";
      stagedFiles = [];
      stagedQueue.innerHTML = "";
      dispatchFilesBtn.disabled = false;
      fileStatusIndicator.textContent = "Sent";
    }, 600);
  });

  function handleIncomingMqttFile(data) {
    const arrayBuf = base64ToArrayBuffer(data.data);
    const blob = new Blob([arrayBuf], { type: data.mime });
    const url = URL.createObjectURL(blob);

    // Auto-download file
    const a = document.createElement("a");
    a.href = url;
    a.download = data.name;
    a.click();

    // In-Chat Media Preview
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble peer";
    bubble.innerHTML = `<div class="chat-author">${data.sender} (Shared File)</div><div>📄 <strong>${data.name}</strong> (${formatBytes(data.size)})</div>`;

    if (data.mime.startsWith("image/")) {
      bubble.innerHTML += `<div class="media-preview-box"><img src="${url}" alt="${data.name}" /></div>`;
    } else if (data.mime.startsWith("video/")) {
      bubble.innerHTML += `<div class="media-preview-box"><video src="${url}" controls></video></div>`;
    } else if (data.mime.startsWith("audio/")) {
      bubble.innerHTML += `<div class="media-preview-box"><audio src="${url}" controls></audio></div>`;
    }

    bubble.innerHTML += `<a href="${url}" download="${data.name}" style="color:#60a5fa; text-decoration: underline; font-size:0.75rem; margin-top:4px; display:inline-block;">Save file</a>`;
    chatStream.appendChild(bubble);
    chatStream.scrollTop = chatStream.scrollHeight;

    log(`File "${data.name}" received and saved.`, "success");
  }

  function renderSentFile(file) {
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble mine";
    bubble.innerHTML = `<div class="chat-author">You</div><div>📤 Sent <strong>${file.name}</strong> (${formatBytes(file.size)})</div>`;
    chatStream.appendChild(bubble);
    chatStream.scrollTop = chatStream.scrollHeight;
  }

  // 6. Real-Time Chat Engine
  function sendChatMessage() {
    const text = chatInputBox.value.trim();
    if (!text || !activePin) return;

    renderChatBubble(myAlias, text, true);

    const payload = { sender: myAlias, text, timestamp: Date.now() };

    // Broadcast across both channels
    if (webRtcConn && webRtcConn.open) {
      webRtcConn.send(JSON.stringify({ type: "chat", ...payload }));
    }
    if (mqttClient) {
      mqttClient.publish(`dhurta/v4/room/${activePin}/chat`, JSON.stringify(payload));
    }

    chatInputBox.value = "";
  }

  sendMessageBtn.addEventListener("click", sendChatMessage);
  chatInputBox.addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendChatMessage();
  });

  function renderChatBubble(author, text, isMine) {
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${isMine ? "mine" : "peer"}`;
    bubble.innerHTML = `<div class="chat-author">${author}</div><div>${text}</div>`;
    chatStream.appendChild(bubble);
    chatStream.scrollTop = chatStream.scrollHeight;
  }

  // 7. Video Calling & Session Recorder
  startCallBtn.addEventListener("click", async () => {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      callVideoGrid.classList.remove("hidden");

      startCallBtn.classList.add("hidden");
      endCallBtn.classList.remove("hidden");

      // Call remote peer via WebRTC if peer ID is available
      const remotePeerId = roomPeers.values().next().value;
      if (remotePeerId && peer) {
        activeCall = peer.call(remotePeerId, localStream);
        activeCall.on("stream", (remoteStream) => {
          remoteVideo.srcObject = remoteStream;
        });
        activeCall.on("close", cleanupCall);
      }
      log("Camera and microphone activated for call.", "info");
    } catch (e) {
      showAlert(`Media permission denied: ${e.message}`, true);
    }
  });

  function handleIncomingCall(call) {
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then((stream) => {
        localStream = stream;
        localVideo.srcObject = stream;
        callVideoGrid.classList.remove("hidden");

        startCallBtn.classList.add("hidden");
        endCallBtn.classList.remove("hidden");

        call.answer(stream);
        activeCall = call;

        call.on("stream", (remoteStream) => {
          remoteVideo.srcObject = remoteStream;
        });
        call.on("close", cleanupCall);
      })
      .catch((e) => showAlert(`Call accept error: ${e.message}`, true));
  }

  function cleanupCall() {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    callVideoGrid.classList.add("hidden");
    startCallBtn.classList.remove("hidden");
    endCallBtn.classList.add("hidden");
  }

  endCallBtn.addEventListener("click", () => {
    if (activeCall) activeCall.close();
    cleanupCall();
  });

  recordSessionBtn.addEventListener("click", async () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      recordSessionBtn.textContent = "⏺ Record";
      recordStatusBar.classList.add("hidden");
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
        a.download = `Dhurta-Session-${Date.now()}.webm`;
        a.click();
        log("Session recording saved to device.", "success");
      };

      mediaRecorder.start();
      recordSessionBtn.textContent = "⏹ Stop Record";
      recordStatusBar.classList.remove("hidden");
      log("Session recording started...", "info");
    } catch (e) {
      showAlert(`Could not start recording: ${e.message}`, true);
    }
  });

  // 8. Room Navigation Handlers
  enterRoomBtn.addEventListener("click", () => {
    enterRoom(pinInput.value.trim());
  });

  randomPinBtn.addEventListener("click", () => {
    const rand = Math.floor(1000 + Math.random() * 9000).toString();
    pinInput.value = rand;
    enterRoom(rand);
  });

  leaveRoomBtn.addEventListener("click", () => {
    if (mqttClient) mqttClient.end();
    if (peer) peer.destroy();
    cleanupCall();

    activePin = null;
    roomPeers.clear();

    inSpace.classList.add("hidden");
    outSpace.classList.remove("hidden");

    roomStatusBadge.className = "status-badge offline";
    roomStatusText.textContent = "Out-Space (No Room)";
  });

  openWindowBtn.addEventListener("click", () => {
    if (directLinkInput.value.startsWith("http")) {
      window.open(directLinkInput.value, "_blank", "width=950,height=820");
    }
  });

  copyLinkBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(directLinkInput.value).then(() => {
      copyLinkBtn.textContent = "Copied!";
      setTimeout(() => (copyLinkBtn.textContent = "Copy"), 2000);
    });
  });

  // 9. Diagnostics Self-Tester
  selfTestBtn.addEventListener("click", () => {
    diagModal.classList.remove("hidden");
    diagResults.innerHTML = "<p>Running diagnostics...</p>";

    const hasRtc = !!(window.RTCPeerConnection && window.MediaRecorder);
    const hasMqtt = typeof mqtt !== "undefined";

    diagResults.innerHTML = `
      <div>● WebRTC & MediaRecorder: ${hasRtc ? "✅ Supported" : "❌ Unsupported"}</div>
      <div>● Global MQTT Room Engine: ${hasMqtt ? "✅ Library Active" : "❌ Failed to Load"}</div>
      <div>● Protocol: ${window.location.protocol === "https:" ? "✅ Secure HTTPS" : "⚠️ HTTP"}</div>
      <div>● Assigned Alias: <strong>${myAlias}</strong></div>
    `;
  });

  // URL Auto-Join Check (?pin=XXXX)
  const urlPin = new URLSearchParams(window.location.search).get("pin");
  if (urlPin && /^\d{4}$/.test(urlPin)) {
    pinInput.value = urlPin;
    enterRoom(urlPin);
  } else {
    // Generate initial PIN in out-space
    const initialPin = Math.floor(1000 + Math.random() * 9000).toString();
    pinInput.value = initialPin;
    const initialUrl = `${window.location.origin}${window.location.pathname}?pin=${initialPin}`;
    directLinkInput.value = initialUrl;
    renderQR(initialUrl);
  }
});