import React, { useEffect, useRef, useState } from "react";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  LinearProgress,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { useObservable } from "rxjs-hooks";
import { LightningBoltIcon } from "@heroicons/react/solid";
import InfoIcon from "@mui/icons-material/Info";
import { ignoreFocus } from "../../utils/focus";
import CloseIcon from "@mui/icons-material/Close";
import { BeatmapDownloadProgressEvent } from "../../api";
import { MissingBeatmapInfo } from "../../services/manager/ScenarioManager";

const replayHints = {
  stable: "In osu! press F2 while being at a score/fail screen to load the replay",
  lazer: "In osu!lazer export the replay at the results screen to load it",
};

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function DownloadingState({ download }: { download?: BeatmapDownloadProgressEvent }) {
  const stage = download?.stage ?? "resolving";
  const mapLabel =
    download?.artist && download?.title
      ? `${download.artist} - ${download.title}${download.difficultyName ? ` [${download.difficultyName}]` : ""}`
      : undefined;

  const transferred = download?.transferredBytes ?? 0;
  const total = download?.totalBytes;
  const hasDeterminateProgress = stage === "downloading" && typeof total === "number" && total > 0;
  const percent = hasDeterminateProgress ? Math.min(100, Math.round((transferred / total) * 100)) : undefined;

  let statusText = "Looking up beatmap by MD5 hash...";
  if (stage === "downloading") {
    statusText = `Downloading beatmap${download?.mirror ? ` from ${download.mirror}` : ""}...`;
  } else if (stage === "importing") {
    statusText = "Importing beatmap locally...";
  }

  return (
    <Stack gap={1.5} alignItems={"center"} sx={{ width: 420, maxWidth: "90%", textAlign: "center" }}>
      <Typography variant={"subtitle1"}>{statusText}</Typography>
      {mapLabel && (
        <Typography variant={"body2"} color={"text.secondary"}>
          {mapLabel}
        </Typography>
      )}
      <Box sx={{ width: "100%" }}>
        <LinearProgress
          variant={hasDeterminateProgress ? "determinate" : "indeterminate"}
          value={percent}
        />
      </Box>
      {stage === "downloading" && transferred > 0 && (
        <Typography variant={"caption"} color={"text.secondary"}>
          {hasDeterminateProgress ? `${formatMegabytes(transferred)} / ${formatMegabytes(total)} (${percent}%)` : formatMegabytes(transferred)}
        </Typography>
      )}
    </Stack>
  );
}

function MissingBeatmapState({ missing }: { missing: MissingBeatmapInfo }) {
  const analysisApp = useAnalysisApp();
  const hasStable = analysisApp.osuFolderService.hasClient("stable");
  const hasLazer = analysisApp.osuFolderService.hasClient("lazer");
  const meta = missing.metadata;

  return (
    <Stack gap={1.5} alignItems={"center"} sx={{ maxWidth: 480, textAlign: "center", px: 2 }}>
      <Typography variant={"h6"}>Beatmap not found locally</Typography>
      {meta ? (
        <Typography color={"text.secondary"}>
          {meta.artist} - {meta.title} [{meta.difficultyName}]
        </Typography>
      ) : (
        <Typography color={"text.secondary"}>MD5: {missing.md5}</Typography>
      )}
      <Stack direction={"row"} gap={1} flexWrap={"wrap"} justifyContent={"center"}>
        {hasLazer && (
          <Button
            variant={"contained"}
            onClick={() =>
              analysisApp.scenarioManager.loadReplay(missing.replayId, {
                forceDownload: true,
                targetOverride: "lazer",
              })
            }
            onFocus={ignoreFocus}
          >
            Download &amp; Import to osu!lazer
          </Button>
        )}
        {hasStable && (
          <Button
            variant={hasLazer ? "outlined" : "contained"}
            onClick={() =>
              analysisApp.scenarioManager.loadReplay(missing.replayId, {
                forceDownload: true,
                targetOverride: "stable",
              })
            }
            onFocus={ignoreFocus}
          >
            Download &amp; Import to osu!stable
          </Button>
        )}
        <Button onClick={() => analysisApp.scenarioManager.clearReplay()} onFocus={ignoreFocus}>
          Close
        </Button>
      </Stack>
    </Stack>
  );
}

function EmptyState() {
  const analysisApp = useAnalysisApp();
  const clients = analysisApp.osuFolderService.getClients();
  return (
    <Stack gap={2} alignItems={"center"}>
      <Stack gap={1} alignItems={"center"}>
        <InfoIcon sx={{ height: "2em", width: "2em" }} />
        <Typography>No replay loaded</Typography>
      </Stack>
      {clients.map((client) => (
        <Stack gap={1} alignItems={"center"} direction={"row"} key={client}>
          <Box component={LightningBoltIcon} sx={{ height: "1em", color: "text.secondary" }} />
          <Typography color={"text.secondary"}>{replayHints[client]}</Typography>
        </Stack>
      ))}
      <Stack gap={1} alignItems={"center"} direction={"row"}>
        <Box component={LightningBoltIcon} sx={{ height: "1em", color: "text.secondary" }} />
        <Typography color={"text.secondary"}>
          You can also load a replay with the menu action &quot;File &gt; Open Replay (Ctrl+O)&quot;
        </Typography>
      </Stack>
    </Stack>
  );
}

export const GameCanvas = () => {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const analysisApp = useAnalysisApp();
  const { status, error, warning, download, missingBeatmap } = useObservable(
    () => analysisApp.scenarioManager.scenario$,
    { status: "DONE" },
  );
  const [warningDismissed, setWarningDismissed] = useState(false);
  useEffect(() => setWarningDismissed(false), [warning]);

  const showOverlay = status !== "DONE";

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.append(analysisApp.stats());
    }
  }, [analysisApp]);
  useEffect(() => {
    if (status === "INIT") {
      analysisApp.stats().hidden = true;
    } else {
      analysisApp.stats().hidden = false;
    }
  }, [status, analysisApp]);

  useEffect(() => {
    if (canvas.current) {
      console.log("Initializing renderer to the canvas");
      analysisApp.onEnter(canvas.current);
    }
    return () => analysisApp.onHide();
  }, [analysisApp]);

  return (
    <Box ref={containerRef} sx={{ borderRadius: 2, overflow: "hidden", position: "relative", flex: 1 }}>
      {status === "DONE" && (
        <Tooltip title={"Close replay"}>
          <IconButton
            sx={{ position: "absolute", right: "0", top: "0" }}
            onClick={() => analysisApp.scenarioManager.clearReplay()}
            onFocus={ignoreFocus}
          >
            <CloseIcon />
          </IconButton>
        </Tooltip>
      )}
      {status === "DONE" && warning && !warningDismissed && (
        <Alert
          severity={"warning"}
          onClose={() => setWarningDismissed(true)}
          sx={{ position: "absolute", left: "50%", bottom: 8, transform: "translateX(-50%)" }}
        >
          {warning}
        </Alert>
      )}
      <canvas
        style={{
          width: "100%",
          height: "100%",
          // , pointerEvents: "none"
        }}
        ref={canvas}
        // This does not work
      />
      {/*Overlay*/}
      {showOverlay && (
        <Box
          sx={{
            position: "absolute",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            top: "0",
            left: "0",
            height: "100%",
            width: "100%",
            backgroundColor: "rgba(0,0,0,0.7)",
          }}
        >
          {status === "INIT" && <EmptyState />}
          {status === "LOADING" && <CircularProgress />}
          {status === "DOWNLOADING" && <DownloadingState download={download} />}
          {status === "MISSING_BEATMAP" && missingBeatmap && <MissingBeatmapState missing={missingBeatmap} />}
          {status === "ERROR" && (
            <Stack gap={1} alignItems={"center"} sx={{ maxWidth: 520, textAlign: "center", px: 2 }}>
              <Typography>Something wrong happened...</Typography>
              {error && <Typography color={"text.secondary"}>{error}</Typography>}
              <Button onClick={() => analysisApp.scenarioManager.clearReplay()} onFocus={ignoreFocus}>
                Close
              </Button>
            </Stack>
          )}
        </Box>
      )}
    </Box>
  );
};
