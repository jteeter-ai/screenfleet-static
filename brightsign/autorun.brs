' ScreenFleet Native BrightSign Package - autorun.brs
' v31b + Activation — Zero-touch provisioning for new players
' OS 9.x compatible — no banned APIs
'
' BOOT MODES:
'   A) Normal boot  — config.json has screenToken → plays content directly
'   B) First boot   — config.json has empty screenToken → activation flow:
'        1. Wait for activate.html to fully load (load-complete)
'        2. Call registerPlayerDevice → get code + URL
'        3. InjectJavascript sfSetDimensions + sfSetActivationCode
'        4. Poll pollPlayerActivation every 12s
'        5. On claimed → WriteConfig → RebootSystem
'
' BANNED OS 9.x APIs (crash with &hf4):
'   roVideoMode.SetMode(), GetHdmiInputStatus(), SetVideoZOrder()
'   roDeviceInfo.GetDeviceUniqueId(), GetModel(), GetDisplayMode()
'   roVideoPlayer, roVideoInput, roAssetFetcher.Download()
'   String.Tokenize() on primitives, Str() without LTrim in JS strings

Function ReadConfig() As Object
    xfer = CreateObject("roUrlTransfer")
    xfer.SetUrl("file:///config.json")
    raw = xfer.GetToString()
    If raw = "" Or raw = Invalid Then Return Invalid
    cfg = ParseJson(raw)
    If cfg = Invalid Then Return Invalid
    tokenStr = ""
    If cfg.screenToken <> Invalid Then tokenStr = cfg.screenToken
    Print "[SF] Config loaded. screenToken=" + tokenStr
    Return cfg
End Function

Function HttpPost(url As String, body As String) As String
    xfer = CreateObject("roUrlTransfer")
    xfer.SetUrl(url)
    xfer.AddHeader("Content-Type", "application/json")
    port = CreateObject("roMessagePort")
    xfer.SetPort(port)
    xfer.AsyncPostFromString(body)
    msg = Wait(15000, port)
    If Type(msg) = "roUrlEvent" Then
        result = msg.GetString()
        If result = Invalid Then Return ""
        Return result
    End If
    Print "[SF] HTTP timeout: " + url
    Return ""
End Function

Function NewTimer() As Object
    Return CreateObject("roTimeSpan")
End Function

Function GetElapsedSecs(ts As Object) As Integer
    Return ts.TotalSeconds()
End Function

Function FetchPayload(apiOrigin As String, screenId As String) As Object
    Print "[SF] Fetching payload for screenId=" + screenId
    q = Chr(34)
    body = "{" + q + "screenId" + q + ":" + q + screenId + q + "," + q + "native_mode" + q + ":true}"
    resp = HttpPost(apiOrigin + "/functions/screenPayload", body)
    If resp = "" Then Print "[SF] Payload fetch failed" : Return Invalid
    payload = ParseJson(resp)
    If payload = Invalid Or payload.status <> "ok" Then Print "[SF] Payload error" : Return Invalid
    zones = 0
    If payload.zones <> Invalid Then zones = payload.zones.Count()
    verStr = ""
    If payload.content_version <> Invalid Then verStr = payload.content_version
    Print "[SF] Payload OK. zones=" + Str(zones) + " version=" + verStr
    Return payload
End Function

Sub SaveManifest(payload As Object)
    json = FormatJson(payload)
    If json = "" Or json = Invalid Then Return
    If WriteAsciiFile("sd:/sf-manifest.json", json) Then
        Print "[SF] Manifest saved"
    Else
        Print "[SF] ERROR: manifest save failed"
    End If
End Sub

Function CheckVersion(apiOrigin As String, screenId As String, currentVersion As String) As Boolean
    q = Chr(34)
    body = "{" + q + "screenId" + q + ":" + q + screenId + q + "}"
    resp = HttpPost(apiOrigin + "/functions/screenVersionCheck", body)
    If resp = "" Then Return false
    data = ParseJson(resp)
    If data = Invalid Then Return false
    newVer = data.content_version
    If newVer <> Invalid And newVer <> "" And newVer <> currentVersion Then
        Print "[SF] New version: " + newVer
        Return true
    End If
    Return false
End Function

Sub DownloadMedia(zones As Object)
    CreateDirectory("sd:/media")
    total = 0 : saved = 0
    For Each zone In zones
        If zone.content_source_type = "playlist" Then
            If zone.playback_track <> Invalid Then
                items = zone.playback_track.items
                If items <> Invalid Then
                    For Each item In items
                        hasUrl  = item.file_url  <> Invalid And item.file_url  <> ""
                        hasName = item.local_name <> Invalid And item.local_name <> ""
                        If hasUrl And hasName Then
                            total = total + 1
                            localPath = "sd:/media/" + item.local_name
                            existXfer = CreateObject("roUrlTransfer")
                            existXfer.SetUrl("file:///" + localPath)
                            existing = existXfer.GetToString()
                            If existing <> "" And existing <> Invalid Then
                                Print "[SF-MEDIA] Exists: " + item.local_name
                            Else
                                dlPort = CreateObject("roMessagePort")
                                xfer = CreateObject("roUrlTransfer")
                                xfer.SetUrl(item.file_url)
                                xfer.SetPort(dlPort)
                                If xfer.AsyncGetToFile(localPath) Then
                                    dlTimer = NewTimer()
                                    While true
                                        dlMsg = Wait(5000, dlPort)
                                        If GetElapsedSecs(dlTimer) > 60 Then Exit While
                                        If Type(dlMsg) = "roUrlEvent" Then
                                            If dlMsg.GetResponseCode() = 200 Then saved = saved + 1
                                            Exit While
                                        End If
                                    End While
                                End If
                            End If
                        End If
                    Next
                End If
            End If
        End If
    Next
    Print "[SF-MEDIA] Done. " + Str(saved) + "/" + Str(total) + " downloaded."
End Sub

Sub WriteConfig(apiOrigin As String, screenToken As String, screenId As String, scrW As Integer, scrH As Integer)
    q = Chr(34)
    cfgJson = "{" + Chr(10)
    cfgJson = cfgJson + "  " + q + "apiOrigin" + q + ": " + q + apiOrigin + q + "," + Chr(10)
    cfgJson = cfgJson + "  " + q + "screenToken" + q + ": " + q + screenToken + q + "," + Chr(10)
    cfgJson = cfgJson + "  " + q + "screenId" + q + ": " + q + screenId + q + "," + Chr(10)
    cfgJson = cfgJson + "  " + q + "screenWidth" + q + ": " + LTrim(Str(scrW)) + "," + Chr(10)
    cfgJson = cfgJson + "  " + q + "screenHeight" + q + ": " + LTrim(Str(scrH)) + "," + Chr(10)
    cfgJson = cfgJson + "  " + q + "pollIntervalMs" + q + ": 60000," + Chr(10)
    cfgJson = cfgJson + "  " + q + "packageVersion" + q + ": " + q + "v31b" + q + Chr(10)
    cfgJson = cfgJson + "}"
    If WriteAsciiFile("sd:/config.json", cfgJson) Then
        Print "[SF-ACTIVATE] config.json written"
    Else
        Print "[SF-ACTIVATE] ERROR: WriteAsciiFile failed"
    End If
End Sub

Function GenerateDeviceId() As String
    ' roDeviceInfo crashes on OS 9.x — read/write a file instead
    idPath = "sd:/sf-device-id.txt"
    xfer = CreateObject("roUrlTransfer")
    xfer.SetUrl("file:///" + idPath)
    existing = xfer.GetToString()
    If existing <> "" And existing <> Invalid Then
        existing = existing.Trim()
        If Len(existing) > 4 Then
            Print "[SF-ACTIVATE] Device ID (file): " + existing
            Return existing
        End If
    End If
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    newId = "bs-"
    For i = 1 To 16
        idx = Int(Rnd(0) * Len(chars)) + 1
        newId = newId + Mid(chars, idx, 1)
    Next i
    WriteAsciiFile(idPath, newId)
    Print "[SF-ACTIVATE] Device ID (new): " + newId
    Return newId
End Function

Sub RunActivationFlow(h As Object, msgPort As Object, apiOrigin As String, scrW As Integer, scrH As Integer)
    Print "[SF-ACTIVATE] Starting activation flow"
    deviceId = GenerateDeviceId()
    q = Chr(34)

    ' ── Step 1: Wait for activate.html load-complete ─────────────────────────
    ' Must wait before calling InjectJavascript so sfSetActivationCode exists
    Print "[SF-ACTIVATE] Waiting for activate.html load-complete..."
    loadTimer = NewTimer()
    pageReady = false
    While Not pageReady And GetElapsedSecs(loadTimer) < 20
        loadMsg = Wait(500, msgPort)
        If Type(loadMsg) = "roHtmlWidgetEvent" Then
            loadData = loadMsg.GetData()
            If Type(loadData) = "roAssociativeArray" Then
                If loadData.reason = "load-complete" Then
                    Print "[SF-ACTIVATE] activate.html ready"
                    h.InjectJavascript("sfSetDimensions(" + LTrim(Str(scrW)) + "," + LTrim(Str(scrH)) + ")")
                    pageReady = true
                End If
            End If
        End If
    End While
    If Not pageReady Then Print "[SF-ACTIVATE] WARNING: load-complete timeout — proceeding anyway"

    ' ── Step 2: Register with backend ────────────────────────────────────────
    regBody = "{" + q + "device_id" + q + ":" + q + deviceId + q + "," + q + "player_type" + q + ":" + q + "brightsign" + q + "," + q + "player_version" + q + ":" + q + "v31b" + q + "}"
    regResp = HttpPost(apiOrigin + "/functions/registerPlayerDevice", regBody)

    If regResp = "" Then
        Print "[SF-ACTIVATE] registerPlayerDevice failed — no network?"
        h.InjectJavascript("document.getElementById('statusText').textContent='No network — retrying...'")
        Wait(10000, msgPort)
        Return
    End If

    regData = ParseJson(regResp)
    If regData = Invalid Then Print "[SF-ACTIVATE] parse failed" : Return

    ' Already claimed (re-boot of activated player)
    If regData.status = "claimed" Then
        Print "[SF-ACTIVATE] Already claimed"
        safeToken = "" : safeId = ""
        If regData.screen_public_token <> Invalid Then safeToken = regData.screen_public_token
        If regData.screen_id <> Invalid Then safeId = regData.screen_id
        If safeToken <> "" Then
            WriteConfig(apiOrigin, safeToken, safeId, scrW, scrH)
            Wait(1000, msgPort)
            RebootSystem()
        End If
        Return
    End If

    activationCode = regData.activation_code
    activateUrl = ""
    If regData.activate_url <> Invalid Then activateUrl = regData.activate_url
    If activateUrl = "" Then activateUrl = "https://app.screenfleet.io/activate?code=" + activationCode

    Print "[SF-ACTIVATE] Code: " + activationCode
    Print "[SF-ACTIVATE] URL: " + activateUrl

    ' ── Step 3: Inject code + QR into page ───────────────────────────────────
    ' LTrim() strips leading space that BrightScript's Str() adds
    ' Inject code text first (simple), then full sfSetActivationCode
    h.InjectJavascript("document.getElementById('codeDisplay').textContent=" + q + activationCode + q)
    jsCall = "sfSetActivationCode(" + q + activationCode + q + "," + q + activateUrl + q + "," + q + deviceId + q + ")"
    h.InjectJavascript(jsCall)

    ' ── Step 4: Poll for activation ──────────────────────────────────────────
    pollBody = "{" + q + "device_id" + q + ":" + q + deviceId + q + "}"
    pollTimer = NewTimer()
    pollCount = 0

    While true
        waitMsg = Wait(12000, msgPort)
        If Type(waitMsg) = "roHtmlWidgetEvent" Then
            waitData = waitMsg.GetData()
            If Type(waitData) = "roAssociativeArray" Then
                If waitData.reason = "load-complete" Then
                    Print "[SF-ACTIVATE] Page reloaded — re-injecting"
                    h.InjectJavascript("sfSetDimensions(" + LTrim(Str(scrW)) + "," + LTrim(Str(scrH)) + ")")
                    h.InjectJavascript("document.getElementById('codeDisplay').textContent=" + q + activationCode + q)
                    h.InjectJavascript(jsCall)
                End If
            End If
        End If

        pollCount = pollCount + 1
        Print "[SF-ACTIVATE] Poll #" + Str(pollCount)

        pollResp = HttpPost(apiOrigin + "/functions/pollPlayerActivation", pollBody)
        If pollResp <> "" Then
            pollData = ParseJson(pollResp)
            If pollData <> Invalid Then
                If pollData.status = "claimed" Then
                    Print "[SF-ACTIVATE] CLAIMED!"
                    h.InjectJavascript("document.getElementById('claimed').className='claimed show'")
                    Wait(2000, msgPort)
                    safeToken = "" : safeId = ""
                    If pollData.screen_public_token <> Invalid Then safeToken = pollData.screen_public_token
                    If pollData.screen_id <> Invalid Then safeId = pollData.screen_id
                    If safeToken <> "" Then
                        WriteConfig(apiOrigin, safeToken, safeId, scrW, scrH)
                        Print "[SF-ACTIVATE] Config written. Rebooting."
                        Wait(1500, msgPort)
                        RebootSystem()
                    End If
                    Return
                Else If pollData.status = "upgrade_required" Then
                    Print "[SF-ACTIVATE] Upgrade required"
                End If
            End If
        End If

        ' Refresh code every 5 minutes
        If GetElapsedSecs(pollTimer) > 300 Then
            pollTimer = NewTimer()
            reregResp = HttpPost(apiOrigin + "/functions/registerPlayerDevice", regBody)
            If reregResp <> "" Then
                reregData = ParseJson(reregResp)
                If reregData <> Invalid And reregData.activation_code <> Invalid Then
                    If reregData.activation_code <> activationCode Then
                        activationCode = reregData.activation_code
                        If reregData.activate_url <> Invalid Then activateUrl = reregData.activate_url
                        jsCall = "sfSetActivationCode(" + q + activationCode + q + "," + q + activateUrl + q + "," + q + deviceId + q + ")"
                        h.InjectJavascript("document.getElementById('codeDisplay').textContent=" + q + activationCode + q)
                        h.InjectJavascript(jsCall)
                        Print "[SF-ACTIVATE] Code refreshed: " + activationCode
                    End If
                End If
            End If
        End If

    End While
End Sub

Sub Main()
    Print "[SF] ScreenFleet v31b starting"
    apiOrigin = "https://app.screenfleet.io"
    scrW = 1920 : scrH = 1080

    msgPort = CreateObject("roMessagePort")
    gaa = GetGlobalAA()
    gaa.vm = CreateObject("roVideoMode")
    If gaa.vm <> Invalid Then gaa.vm.SetPort(msgPort)

    cfg = ReadConfig()
    isFirstBoot = false

    If cfg = Invalid Then
        isFirstBoot = true
        Print "[SF] No config.json — first boot"
    Else If cfg.screenToken = Invalid Or cfg.screenToken = "" Then
        isFirstBoot = true
        Print "[SF] Empty screenToken — activation required"
    Else
        If cfg.apiOrigin <> Invalid And cfg.apiOrigin <> "" Then apiOrigin = cfg.apiOrigin
        If cfg.screenWidth  <> Invalid And cfg.screenWidth  > 0 Then scrW = cfg.screenWidth
        If cfg.screenHeight <> Invalid And cfg.screenHeight > 0 Then scrH = cfg.screenHeight
    End If

    ' Launch widget
    r = CreateObject("roRectangle", 0, 0, scrW, scrH)
    hCfg = {
        url: "file:///activate.html",
        javascript_enabled: true,
        nodejs_enabled: true,
        brightsign_js_objects_enabled: true,
        security_params: { websecurity: false },
        inspector_server: { port: 2999 }
    }
    h = CreateObject("roHtmlWidget", r, hCfg)
    h.SetPort(msgPort)
    h.Show()

    If isFirstBoot Then
        Print "[SF] Running activation flow..."
        RunActivationFlow(h, msgPort, apiOrigin, scrW, scrH)
        Print "[SF] Activation exited — retrying in 30s"
        Wait(30000, msgPort)
        RebootSystem()
        Return
    End If

    ' Normal boot — switch to player
    ' Build safe strings first (concatenating Invalid crashes with &hf4)
    q = Chr(34)
    safeScreenId = ""
    safeToken = ""
    If cfg.screenId <> Invalid Then safeScreenId = cfg.screenId
    If cfg.screenToken <> Invalid Then safeToken = cfg.screenToken
    Print "[SF] Normal boot. screenId=" + safeScreenId
    h.SetUrl("file:///index.html")

    currentVersion = ""
    fetchId = safeScreenId
    If fetchId = "" Then fetchId = safeToken

    ' Build the config injection JS. player.js cannot fetch() file:// URLs,
    ' so autorun.brs injects config directly via window.sfSetConfig().
    cfgInject = "sfSetConfig(" + q + apiOrigin + q + "," + q + safeScreenId + q + "," + q + safeToken + q + "," + LTrim(Str(scrW)) + "," + LTrim(Str(scrH)) + ")"

    ' Wait for index.html to load before injecting config and fetching payload
    Print "[SF] Waiting for index.html load-complete..."
    idxTimer = NewTimer()
    idxReady = false
    While Not idxReady And GetElapsedSecs(idxTimer) < 20
        idxMsg = Wait(500, msgPort)
        If Type(idxMsg) = "roHtmlWidgetEvent" Then
            idxData = idxMsg.GetData()
            If Type(idxData) = "roAssociativeArray" Then
                If idxData.reason = "load-complete" Then
                    Print "[SF] index.html ready — injecting config"
                    h.InjectJavascript(cfgInject)
                    idxReady = true
                End If
            End If
        End If
    End While
    If Not idxReady Then
        Print "[SF] index.html load timeout — injecting config anyway"
        h.InjectJavascript(cfgInject)
    End If

    payload = FetchPayload(apiOrigin, fetchId)
    If payload <> Invalid Then
        currentVersion = payload.content_version
        SaveManifest(payload)
        If payload.zones <> Invalid Then DownloadMedia(payload.zones)
        h.InjectJavascript("sfLoadManifest();")
        Print "[SF] Payload fetched. sfLoadManifest() called."
    Else
        Print "[SF] No network payload — using saved manifest"
    End If

    Print "[SF] Entering event loop."
    versionTimer = NewTimer()

    While true
        msg = Wait(0, msgPort)

        If GetElapsedSecs(versionTimer) >= 60 Then
            versionTimer = NewTimer()
            If currentVersion <> "" Then
                If CheckVersion(apiOrigin, fetchId, currentVersion) Then
                    Print "[SF] Version changed — fetching"
                    newPayload = FetchPayload(apiOrigin, fetchId)
                    If newPayload <> Invalid Then
                        SaveManifest(newPayload)
                        If newPayload.zones <> Invalid Then DownloadMedia(newPayload.zones)
                        currentVersion = newPayload.content_version
                        h.InjectJavascript("sfLoadManifest();")
                    End If
                End If
            End If
        End If

        If Type(msg) = "roHdmiInputChanged" Then
            Print "[SF-HDMI] Signal changed — sfReloadHdmi()"
            h.InjectJavascript("sfReloadHdmi();")
        End If

        If Type(msg) = "roHtmlWidgetEvent" Then
            data = msg.GetData()
            If Type(data) = "roAssociativeArray" Then
                If data.reason = "load-complete" Then
                    Print "[SF] load-complete — re-injecting config + sfReloadHdmi()"
                    h.InjectJavascript(cfgInject)
                    h.InjectJavascript("sfReloadHdmi();")
                Else If data.reason = "load-error" Then
                    Print "[SF] load-error — retrying in 15s"
                    Sleep(15000)
                    h.SetUrl("file:///index.html")
                End If
            End If
        End If

    End While
End Sub
