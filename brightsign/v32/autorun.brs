' ScreenFleet BrightSign player - autorun.brs v32
' One universal package for every player. Nothing in it is tied to an asset.
'
' BOOT
'   config.json has a screenToken -> play content (index.html + player.js)
'   config.json empty / missing    -> activation screen with code + QR,
'                                     claimed in ScreenFleet, then reboot into play
'
' WHAT CHANGED FROM v31b
'   - Main loop wakes every second (v31b used Wait(0) and could stall timers)
'   - Heartbeat every 60 s so ScreenFleet shows the player online/offline
'   - HTML page is sized to the player's real output resolution
'   - All files live on the storage the player booted from (SD or SSD), not a hardcoded sd:/
'   - Media downloads go to a .part file first, so a dropped download never plays half a video
'   - New content switches only after every file is on the card (like BSN.cloud); unused files are pruned
'   - Every scheduled playlist is on the card, and player.js picks the active one by local time,
'     so schedules keep working after a reboot with no internet
'   - HDMI hot-plug follows BrightSign's sample: roVideoMode events -> reloadHdmi in the page
'   - Web inspector is off unless config.json sets "debug": true
'   - No network at activation no longer reboot-loops; it retries in place
'
' AVOIDED ON OS 9.x (caused &hF4 crashes on earlier versions):
'   roVideoMode.SetMode(), GetHdmiInputStatus(), SetVideoZOrder(),
'   roDeviceInfo, roVideoPlayer/roVideoInput

Function SfVersion() As String
    Return "v32"
End Function

' ---------------------------------------------------------------- helpers

Function FileExists(path As String) As Boolean
    f = CreateObject("roReadFile", path)
    Return Type(f) = "roReadFile"
End Function

Function ReadText(path As String) As String
    If Not FileExists(path) Then Return ""
    s = ReadAsciiFile(path)
    If s = Invalid Then Return ""
    Return s
End Function

Function ReadConfig() As Object
    raw = ReadText("config.json")
    If raw = "" Then Return Invalid
    cfg = ParseJson(raw)
    If Type(cfg) <> "roAssociativeArray" Then Return Invalid
    Return cfg
End Function

Function Str2(v As Dynamic) As String
    ' Safe string for any value (concatenating Invalid crashes BrightScript)
    If v = Invalid Then Return ""
    t = Type(v)
    If t = "roString" Or t = "String" Then Return v
    If t = "roInt" Or t = "Integer" Or t = "LongInteger" Or t = "roFloat" Or t = "Float" Or t = "Double" Or t = "roDouble" Then Return LTrim(Str(v))
    If t = "roBoolean" Or t = "Boolean" Then
        If v Then Return "true"
        Return "false"
    End If
    Return ""
End Function

Function JsStr(s As String) As String
    ' Quote a string for InjectJavascript / JSON
    q = Chr(34)
    out = ""
    For i = 1 To Len(s)
        c = Mid(s, i, 1)
        If c = q Or c = "\" Then
            out = out + "\" + c
        Else If Asc(c) >= 32 Then
            out = out + c
        End If
    Next
    Return q + out + q
End Function

Function NewUrlTransfer(url As String) As Object
    xfer = CreateObject("roUrlTransfer")
    xfer.SetUrl(url)
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    Return xfer
End Function

Function HttpPost(url As String, body As String) As String
    xfer = NewUrlTransfer(url)
    xfer.AddHeader("Content-Type", "application/json")
    port = CreateObject("roMessagePort")
    xfer.SetPort(port)
    If Not xfer.AsyncPostFromString(body) Then Return ""
    msg = Wait(20000, port)
    If Type(msg) = "roUrlEvent" Then
        If msg.GetResponseCode() >= 200 And msg.GetResponseCode() < 300 Then
            result = msg.GetString()
            If result = Invalid Then Return ""
            Return result
        End If
        Print "[SF] HTTP " + Str2(msg.GetResponseCode()) + " from " + url
        Return ""
    End If
    xfer.AsyncCancel()
    Print "[SF] HTTP timeout: " + url
    Return ""
End Function

Function NewTimer() As Object
    Return CreateObject("roTimeSpan")
End Function

Function Secs(ts As Object) As Integer
    Return ts.TotalSeconds()
End Function

Function StripWs(s As String) As String
    While Len(s) > 0 And Asc(Left(s, 1)) <= 32
        s = Mid(s, 2)
    End While
    While Len(s) > 0 And Asc(Right(s, 1)) <= 32
        s = Left(s, Len(s) - 1)
    End While
    Return s
End Function

' ---------------------------------------------------------------- content

Function FetchPayload(apiOrigin As String, screenId As String) As Object
    body = "{" + JsStr("screenId") + ":" + JsStr(screenId) + "," + JsStr("native_mode") + ":true}"
    resp = HttpPost(apiOrigin + "/functions/screenPayload", body)
    If resp = "" Then
        Print "[SF] Payload fetch failed"
        Return Invalid
    End If
    payload = ParseJson(resp)
    If Type(payload) <> "roAssociativeArray" Then Return Invalid
    If Str2(payload.status) <> "ok" Then
        Print "[SF] Payload status: " + Str2(payload.status)
        Return Invalid
    End If
    Print "[SF] Payload OK. version=" + Str2(payload.content_version)
    Return payload
End Function

Sub SaveManifest(payload As Object)
    json = FormatJson(payload)
    If json = Invalid Or json = "" Then Return
    If WriteAsciiFile("sf-manifest.tmp", json) Then
        DeleteFile("sf-manifest.json")
        MoveFile("sf-manifest.tmp", "sf-manifest.json")
        Print "[SF] Manifest saved"
    Else
        Print "[SF] ERROR: manifest save failed (storage full or read-only?)"
    End If
End Sub

Function CheckVersion(apiOrigin As String, screenId As String, currentVersion As String) As Boolean
    resp = HttpPost(apiOrigin + "/functions/screenVersionCheck", "{" + JsStr("screenId") + ":" + JsStr(screenId) + "}")
    If resp = "" Then Return false
    data = ParseJson(resp)
    If Type(data) <> "roAssociativeArray" Then Return false
    newVer = Str2(data.content_version)
    Return newVer <> "" And newVer <> currentVersion
End Function

Function DownloadFile(url As String, localPath As String) As Boolean
    partPath = localPath + ".part"
    DeleteFile(partPath)
    port = CreateObject("roMessagePort")
    xfer = NewUrlTransfer(url)
    xfer.SetPort(port)
    If Not xfer.AsyncGetToFile(partPath) Then Return false
    ' Allow up to 15 minutes for one file (large videos over LTE)
    msg = Wait(900000, port)
    If Type(msg) = "roUrlEvent" Then
        If msg.GetResponseCode() = 200 Then
            DeleteFile(localPath)
            Return MoveFile(partPath, localPath)
        End If
        Print "[SF-MEDIA] HTTP " + Str2(msg.GetResponseCode()) + " for " + url
    Else
        xfer.AsyncCancel()
        Print "[SF-MEDIA] Timeout for " + url
    End If
    DeleteFile(partPath)
    Return false
End Function

Function DownloadMedia(payload As Object) As Boolean
    ' Like BSN.cloud: every file the schedule can play is stored on the card.
    ' Returns true only when every file is present, so old files are pruned only then.
    CreateDirectory("media")
    wanted = {}
    total = 0 : have = 0 : saved = 0 : failed = 0
    list = payload.native_media_manifest
    If Type(list) = "roArray" Then
        For Each m In list
            url = Str2(m.url)
            name = Str2(m.name)
            If url <> "" And name <> "" And Not wanted.DoesExist(name) Then
                wanted[name] = true
                total = total + 1
                localPath = "media/" + name
                If FileExists(localPath) Then
                    have = have + 1
                Else If DownloadFile(url, localPath) Then
                    saved = saved + 1
                Else
                    failed = failed + 1
                End If
            End If
        Next
    End If
    Print "[SF-MEDIA] " + Str2(total) + " files: " + Str2(have) + " on card, " + Str2(saved) + " downloaded, " + Str2(failed) + " failed"
    If failed > 0 Or total = 0 Then Return (failed = 0)

    ' Remove files no longer used by any schedule (keeps the card from filling up)
    files = ListDir("media")
    If files <> Invalid Then
        For Each f In files
            If Not wanted.DoesExist(f) Then
                DeleteFile("media/" + f)
                Print "[SF-MEDIA] Removed unused " + f
            End If
        Next
    End If
    Return true
End Function

Sub SendHeartbeat(apiOrigin As String, screenId As String, screenToken As String, contentVersion As String)
    body = "{" + JsStr("screen_id") + ":" + JsStr(screenId) + "," + JsStr("screen_token") + ":" + JsStr(screenToken) + "," + JsStr("content_version") + ":" + JsStr(contentVersion) + "," + JsStr("player_version") + ":" + JsStr("brightsign-" + SfVersion()) + "}"
    HttpPost(apiOrigin + "/functions/reportHeartbeat", body)
End Sub

' ---------------------------------------------------------------- activation

Sub WriteConfig(apiOrigin As String, screenToken As String, screenId As String, outW As Integer, outH As Integer)
    q = Chr(34)
    nl = Chr(10)
    cfgJson = "{" + nl
    cfgJson = cfgJson + "  " + q + "apiOrigin" + q + ": " + JsStr(apiOrigin) + "," + nl
    cfgJson = cfgJson + "  " + q + "screenToken" + q + ": " + JsStr(screenToken) + "," + nl
    cfgJson = cfgJson + "  " + q + "screenId" + q + ": " + JsStr(screenId) + "," + nl
    cfgJson = cfgJson + "  " + q + "screenWidth" + q + ": " + Str2(outW) + "," + nl
    cfgJson = cfgJson + "  " + q + "screenHeight" + q + ": " + Str2(outH) + "," + nl
    cfgJson = cfgJson + "  " + q + "pollIntervalMs" + q + ": 60000," + nl
    cfgJson = cfgJson + "  " + q + "packageVersion" + q + ": " + JsStr(SfVersion()) + nl
    cfgJson = cfgJson + "}"
    If WriteAsciiFile("config.json", cfgJson) Then
        Print "[SF-ACTIVATE] config.json written"
    Else
        Print "[SF-ACTIVATE] ERROR: could not write config.json"
    End If
End Sub

Function GetDeviceId() As String
    ' Stable per player: generated once, kept on the card.
    existing = StripWs(ReadText("sf-device-id.txt"))
    If Len(existing) > 4 Then Return existing
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    newId = "bs-"
    For i = 1 To 16
        newId = newId + Mid(chars, Rnd(Len(chars)), 1)
    Next
    WriteAsciiFile("sf-device-id.txt", newId)
    Print "[SF-ACTIVATE] New device id: " + newId
    Return newId
End Function

Function HandleClaimed(h As Object, msgPort As Object, data As Object, apiOrigin As String, outW As Integer, outH As Integer) As Boolean
    token = Str2(data.screen_public_token)
    If token = "" Then Return false
    h.InjectJavascript("if(window.sfShowClaimed)sfShowClaimed();")
    WriteConfig(apiOrigin, token, Str2(data.screen_id), outW, outH)
    Print "[SF-ACTIVATE] Claimed. Rebooting into play mode."
    Wait(2500, msgPort)
    RebootSystem()
    Return true
End Function

Sub RunActivation(h As Object, msgPort As Object, apiOrigin As String, outW As Integer, outH As Integer)
    deviceId = GetDeviceId()
    regBody = "{" + JsStr("device_id") + ":" + JsStr(deviceId) + "," + JsStr("player_type") + ":" + JsStr("brightsign") + "," + JsStr("player_version") + ":" + JsStr("brightsign-" + SfVersion()) + "}"
    pollBody = "{" + JsStr("device_id") + ":" + JsStr(deviceId) + "}"
    dims = "if(window.sfSetDimensions)sfSetDimensions(" + Str2(outW) + "," + Str2(outH) + ");"

    code = ""
    showJs = ""
    regTimer = NewTimer()
    pollTimer = NewTimer()
    needRegister = true

    While true
        msg = Wait(1000, msgPort)

        If Type(msg) = "roHtmlWidgetEvent" Then
            d = msg.GetData()
            If Type(d) = "roAssociativeArray" Then
                If Str2(d.reason) = "load-complete" Then
                    h.InjectJavascript(dims)
                    If showJs <> "" Then h.InjectJavascript(showJs)
                End If
            End If
        End If

        ' Register now, retry every 15 s until we have a code, then refresh every 5 minutes
        regDue = false
        If code = "" Then
            If needRegister Or Secs(regTimer) >= 15 Then regDue = true
        Else If Secs(regTimer) >= 300 Then
            regDue = true
        End If
        If regDue Then
            regTimer = NewTimer()
            resp = HttpPost(apiOrigin + "/functions/registerPlayerDevice", regBody)
            data = Invalid
            If resp <> "" Then data = ParseJson(resp)
            If Type(data) = "roAssociativeArray" Then
                If Str2(data.status) = "claimed" Then
                    If HandleClaimed(h, msgPort, data, apiOrigin, outW, outH) Then Return
                End If
                newCode = Str2(data.activation_code)
                If newCode <> "" And newCode <> code Then
                    code = newCode
                    url = Str2(data.activate_url)
                    If url = "" Then url = apiOrigin + "/activate?code=" + code
                    showJs = "if(window.sfSetActivationCode)sfSetActivationCode(" + JsStr(code) + "," + JsStr(url) + "," + JsStr(deviceId) + ");"
                    h.InjectJavascript(dims)
                    h.InjectJavascript(showJs)
                    Print "[SF-ACTIVATE] Code " + code
                End If
                needRegister = false
            Else
                needRegister = false
                h.InjectJavascript("if(window.sfSetStatus)sfSetStatus('No network connection - retrying...');")
            End If
        End If

        ' Poll for the claim every 10 s
        If code <> "" And Secs(pollTimer) >= 10 Then
            pollTimer = NewTimer()
            resp = HttpPost(apiOrigin + "/functions/pollPlayerActivation", pollBody)
            If resp <> "" Then
                data = ParseJson(resp)
                If Type(data) = "roAssociativeArray" Then
                    If Str2(data.status) = "claimed" Then
                        If HandleClaimed(h, msgPort, data, apiOrigin, outW, outH) Then Return
                    End If
                End If
            End If
        End If
    End While
End Sub

' ---------------------------------------------------------------- main

Sub Main()
    Print "[SF] ScreenFleet " + SfVersion() + " starting"
    apiOrigin = "https://app.screenfleet.io"

    msgPort = CreateObject("roMessagePort")

    ' roVideoMode is only used to learn the output size and to receive HDMI-in
    ' hot-plug events (BrightSign's own HDMI sample does the same).
    vm = CreateObject("roVideoMode")
    outW = 0 : outH = 0
    If vm <> Invalid Then
        vm.SetPort(msgPort)
        outW = vm.GetResX()
        outH = vm.GetResY()
    End If

    cfg = ReadConfig()
    token = "" : screenId = "" : debug = false
    If cfg <> Invalid Then
        token = Str2(cfg.screenToken)
        screenId = Str2(cfg.screenId)
        If Str2(cfg.apiOrigin) <> "" Then apiOrigin = cfg.apiOrigin
        If Str2(cfg.debug) = "true" Then debug = true
        If outW <= 0 And cfg.screenWidth <> Invalid Then outW = cfg.screenWidth
        If outH <= 0 And cfg.screenHeight <> Invalid Then outH = cfg.screenHeight
    End If
    If outW <= 0 Or outH <= 0 Then
        outW = 1920 : outH = 1080
    End If
    Print "[SF] Output " + Str2(outW) + "x" + Str2(outH)

    activating = (token = "")
    startUrl = "file:///index.html"
    If activating Then startUrl = "file:///activate.html"

    hCfg = {
        url: startUrl,
        javascript_enabled: true,
        nodejs_enabled: true,
        brightsign_js_objects_enabled: true,
        mouse_enabled: false,
        security_params: { websecurity: false }
    }
    If debug Then hCfg.inspector_server = { port: 2999 }

    h = CreateObject("roHtmlWidget", CreateObject("roRectangle", 0, 0, outW, outH), hCfg)
    h.SetPort(msgPort)
    h.Show()

    If activating Then
        RunActivation(h, msgPort, apiOrigin, outW, outH)
        Return
    End If

    fetchId = screenId
    If fetchId = "" Then fetchId = token
    cfgInject = "if(window.sfSetConfig)sfSetConfig(" + JsStr(apiOrigin) + "," + JsStr(screenId) + "," + JsStr(token) + "," + Str2(outW) + "," + Str2(outH) + "," + JsStr(SfVersion()) + ");"

    ' Deliver config: on every load-complete, plus once a second for the first 10 s
    ' in case the load-complete event was missed.
    bootTimer = NewTimer()
    booting = true

    ' What is already on the card (so a reboot does not redo a finished download)
    currentVersion = ""
    saved = ParseJson(ReadText("sf-manifest.json"))
    If Type(saved) = "roAssociativeArray" Then currentVersion = Str2(saved.content_version)
    saved = Invalid
    Print "[SF] Content on card: " + currentVersion
    firstFetchDone = false
    versionTimer = NewTimer()
    heartbeatTimer = NewTimer()
    firstHeartbeat = true
    reloadTimer = Invalid

    While true
        msg = Wait(1000, msgPort)
        mt = Type(msg)

        If mt = "roHtmlWidgetEvent" Then
            d = msg.GetData()
            If Type(d) = "roAssociativeArray" Then
                If Str2(d.reason) = "load-complete" Then
                    h.InjectJavascript(cfgInject)
                Else If Str2(d.reason) = "load-error" Then
                    Print "[SF] Page load error - retrying in 15 s"
                    reloadTimer = NewTimer()
                End If
            End If
        Else If mt = "roHdmiInputChanged" Then
            ' Do not query GetHdmiInputStatus (crashes on some OS 9 builds).
            ' Reloading the HDMI <video> is harmless when the signal went away.
            Print "[SF-HDMI] Input changed - reloading HDMI video"
            h.InjectJavascript("if(window.reloadHdmiIn)reloadHdmiIn();")
        End If

        If booting Then
            h.InjectJavascript(cfgInject)
            If Secs(bootTimer) >= 10 Then booting = false
        End If

        If reloadTimer <> Invalid Then
            If Secs(reloadTimer) >= 15 Then
                reloadTimer = Invalid
                h.SetUrl("file:///index.html")
            End If
        End If

        ' First content fetch once the page has had its config
        If Not firstFetchDone And Not booting Then
            firstFetchDone = true
            payload = FetchPayload(apiOrigin, fetchId)
            If payload <> Invalid Then
                If DownloadMedia(payload) Then
                    currentVersion = Str2(payload.content_version)
                    SaveManifest(payload)
                    h.InjectJavascript("if(window.sfLoadManifest)sfLoadManifest();")
                Else
                    Print "[SF] Some media failed - keeping the current schedule, will retry in 60 s"
                End If
            Else
                Print "[SF] Offline - playing the saved manifest"
            End If
            versionTimer = NewTimer()
        End If

        ' New content check every 60 s
        If firstFetchDone And Secs(versionTimer) >= 60 Then
            versionTimer = NewTimer()
            If currentVersion = "" Or CheckVersion(apiOrigin, fetchId, currentVersion) Then
                newPayload = FetchPayload(apiOrigin, fetchId)
                If newPayload <> Invalid Then
                    If Str2(newPayload.content_version) <> currentVersion Then
                        Print "[SF] New content version " + Str2(newPayload.content_version) + " - downloading before switching"
                        If DownloadMedia(newPayload) Then
                            SaveManifest(newPayload)
                            currentVersion = Str2(newPayload.content_version)
                            h.InjectJavascript("if(window.sfLoadManifest)sfLoadManifest();")
                        End If
                    End If
                End If
            End If
        End If

        ' Heartbeat every 60 s (first one ~15 s after boot)
        If (firstHeartbeat And Secs(heartbeatTimer) >= 15) Or Secs(heartbeatTimer) >= 60 Then
            firstHeartbeat = false
            heartbeatTimer = NewTimer()
            SendHeartbeat(apiOrigin, screenId, token, currentVersion)
        End If
    End While
End Sub
