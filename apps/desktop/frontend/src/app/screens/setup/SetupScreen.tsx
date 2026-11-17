import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Box, Button, IconButton, InputBase, Paper, Stack, Tooltip, Typography } from "@mui/material";
import { RewindLogo } from "../../components/logo/RewindLogo";
import { Clear, Help, RocketLaunch } from "@mui/icons-material";
import FolderIcon from "@mui/icons-material/Folder";
import { frontendAPI } from "../../api";
import { useNavigate } from "react-router-dom";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { guessOsuFolder, OSU_CLIENTS, OsuClient } from "../../services/common/local/OsuFolderService";

interface DirectorySelectionProps {
  value: string | null;
  onChange: (value: string | null) => void;
  placeHolder: string;
  badgeOnEmpty?: boolean;
}

function DirectorySelection({ value, onChange, placeHolder, badgeOnEmpty }: DirectorySelectionProps) {
  const handleSelectFolderClick = useCallback(() => {
    frontendAPI.selectDirectory(value ?? "").then((path) => {
      if (path !== null) {
        onChange(path);
      }
    });
  }, [onChange, value]);

  const invisibleBadge = !badgeOnEmpty || !!value;
  return (
    <Paper sx={{ px: 2, py: 1, display: "flex", alignItems: "center", width: 440 }} elevation={2}>
      <InputBase sx={{ flex: 1 }} placeholder={placeHolder} value={value ?? ""} disabled={true} />
      {value && (
        <Tooltip title={"Don't use this installation"}>
          <IconButton onClick={() => onChange(null)}>
            <Clear />
          </IconButton>
        </Tooltip>
      )}
      <IconButton onClick={handleSelectFolderClick}>
        <Badge invisible={invisibleBadge} color={"primary"} variant={"dot"}>
          <FolderIcon />
        </Badge>
      </IconButton>
    </Paper>
  );
}

const setupWikiUrl = "https://github.com/abstrakt8/rewind/wiki/Setup";

const clientLabel: Record<OsuClient, string> = {
  stable: "osu!stable",
  lazer: "osu!lazer",
};

const placeHolders: Record<OsuClient, string> = {
  stable: "Select your osu! folder (optional)",
  lazer: "Select your osu!lazer data folder (optional)",
};

type FolderPaths = Record<OsuClient, string | null>;
type FolderErrors = Partial<Record<OsuClient, string>>;

export function SetupScreen() {
  const navigate = useNavigate();
  const analyzer = useAnalysisApp();
  const { osuFolderService } = analyzer;
  const [paths, setPaths] = useState<FolderPaths>(() => ({
    stable: osuFolderService.getStableFolder() ?? null,
    lazer: osuFolderService.getLazerFolder() ?? null,
  }));
  const [errors, setErrors] = useState<FolderErrors>({});
  const [canCancel, setCanCancel] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void osuFolderService.hasValidOsuFolderSet().then((valid) => !cancelled && setCanCancel(valid));
    // Pre-fill the installations that are found at their default locations
    if (osuFolderService.getClients().length === 0) {
      void Promise.all(OSU_CLIENTS.map(guessOsuFolder)).then(([stable, lazer]) => {
        if (!cancelled) setPaths((p) => ({ stable: p.stable ?? stable, lazer: p.lazer ?? lazer }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [osuFolderService]);

  const handleConfirmClick = useCallback(async () => {
    const newErrors: FolderErrors = {};
    const folders: FolderPaths = { stable: null, lazer: null };
    for (const client of OSU_CLIENTS) {
      const path = paths[client];
      if (!path) continue;
      const osuFolder = await osuFolderService.detectOsuFolder(path);
      if (!osuFolder) {
        newErrors[client] = `Does not look like a valid ${clientLabel[client]} folder!`;
      } else if (osuFolder.client !== client) {
        newErrors[client] = `This is an ${clientLabel[osuFolder.client]} folder, not an ${clientLabel[client]} one!`;
      } else {
        folders[client] = osuFolder.path;
      }
    }
    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) return;
    osuFolderService.setOsuFolders(folders);
    navigate("/app/analyzer");
  }, [navigate, osuFolderService, paths]);

  const handleOnDirectoryChange = useCallback((client: OsuClient, path: string | null) => {
    setPaths((p) => ({ ...p, [client]: path }));
    setErrors((e) => ({ ...e, [client]: undefined }));
  }, []);

  const saveEnabled = OSU_CLIENTS.some((client) => !!paths[client]);

  return (
    <Box
      sx={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Paper elevation={1}>
        <Stack gap={2} sx={{ px: 6, py: 4 }}>
          <RewindLogo />
          <Typography color={"text.secondary"} sx={{ maxWidth: 440 }}>
            Select the osu!stable folder, the osu!lazer folder or both. If both are used, replays can be loaded no
            matter which of the two the beatmap is imported in.
          </Typography>
          {OSU_CLIENTS.map((client) => (
            <Stack gap={1} key={client}>
              <Typography variant={"subtitle2"}>{clientLabel[client]}</Typography>
              {errors[client] && (
                <Alert severity="error" variant="filled">
                  {errors[client]}
                </Alert>
              )}
              <DirectorySelection
                value={paths[client]}
                onChange={(path) => handleOnDirectoryChange(client, path)}
                placeHolder={placeHolders[client]}
                badgeOnEmpty={!saveEnabled}
              />
            </Stack>
          ))}
          <Stack direction={"row-reverse"} gap={2}>
            <Button
              variant={"contained"}
              startIcon={<RocketLaunch />}
              disabled={!saveEnabled}
              onClick={handleConfirmClick}
            >
              Save & Continue
            </Button>
            {canCancel && (
              <Button variant={"text"} onClick={() => navigate("/app/analyzer")}>
                Cancel
              </Button>
            )}
            <Button variant={"text"} onClick={() => window.open(setupWikiUrl)} startIcon={<Help />}>
              Help
            </Button>
          </Stack>
        </Stack>
      </Paper>
    </Box>
  );
}
