import { injectable } from "inversify";
import { Subject } from "rxjs";
import * as chokidar from "chokidar";
import { OsuFolderService } from "./OsuFolderService";

@injectable()
export class ReplayFileWatcher {
  public readonly newReplays$: Subject<string>;
  private watcher?: chokidar.FSWatcher;

  constructor(private readonly osuFolderService: OsuFolderService) {
    this.newReplays$ = new Subject<string>();
  }

  public startWatching() {
    this.osuFolderService.replaysFolders$.subscribe(this.onNewReplayFolders.bind(this));
  }

  // Unsubscribes from the old replay folders and starts listening on the new folders that were given (the "Replays"
  // folder of osu!stable and the "exports" folder of osu!lazer if both are used)
  private onNewReplayFolders(folders: string[]) {
    // For now, we just use .close()
    // We could make it cleaner by using .unwatch() and adding new files to watch
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = undefined;
    }
    if (folders.length === 0) {
      return;
    }

    console.log(`Watching for replays (.osr) in folders: ${folders.join(", ")}`);
    this.watcher = chokidar.watch(folders, {
      // ignoreInitial must be true otherwise addDir will be triggered for every folder initially.
      ignoreInitial: true,
      persistent: true,
      depth: 0, // if somehow osu! is trolling, this will prevent it
    });
    this.watcher.on("add", (path) => {
      if (!path.endsWith(".osr")) {
        return;
      }
      console.log(`Detected new file at: ${path}`);
      this.newReplays$.next(path);
    });
  }
}
