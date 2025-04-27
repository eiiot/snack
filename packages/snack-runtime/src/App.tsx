import './polyfill';

import { StatusBar } from 'expo-status-bar';
import * as React from 'react';
import { Platform } from 'react-native';
import { createVirtualModulePath } from 'snack-require-context';

import { AppLoading } from './AppLoading';
import * as Errors from './Errors';
import * as Files from './Files';
import LoadingView from './LoadingView';
import * as Logger from './Logger';
import * as Modules from './Modules';
import { isExpoRouterEntry } from './NativeModules/ExpoRouter';
import { SnackRuntimeContext } from './config/SnackConfig';
import { type SnackApiCode } from './utils/ExpoApi';

export type SnackState = 'loading' | 'finished' | 'not-found' | 'error';

type Props = {
  /**
   * When passing a Snack URL, the Snack will be loaded instead of the barcode scanner.
   * URLs must have the following format:
   *   - `(exp|https)://exp.host/{owner}/{snackName}+{snackSessionId}`
   *     This loads a Snack, and connects to the Snack website using the session ID.
   *   - `(exp|https)://exp.host/{owner}/{snackName}`
   *     This loads a Snack directly from the API, and won't connect to any editor.
   *
   * @example exp://exp.host/@bycedric/great-bagel+REEOUkskIw
   * @example https://exp.host/@bycedric/great-pancake
   */
  snackCode: SnackApiCode;

  /**
   * Callback for Snack state changes, like "loading" or "finished".
   */
  onSnackState?: (state: SnackState) => any;
};

type State = {
  initialLoad: boolean;
  showSplash: boolean;
  rootElement: React.ReactElement | null;
  foreground: boolean;
  loadingElement: React.ReactNode;
};

// Last known Snack state workaround, the App component is too big to incorporate the state updates
let prevSnackState: SnackState;
/** Notify the `onSnackState` event callback whenever the Snack changes its state */
function notifyStateChange(props: Pick<Props, 'onSnackState'>, state: SnackState) {
  if (state !== prevSnackState) {
    props.onSnackState?.(state);
  }
}

// The root component for Snack's viewer. Allows scanning a barcode to identify a Snack, listens for
// updates and displays the Snack.
export default class App extends React.Component<Props, State> {
  static contextType = SnackRuntimeContext;

  state: State = {
    initialLoad: true,
    showSplash: Platform.OS !== 'web',
    rootElement: null, // Root React element produced by the user's application
    foreground: true,
    loadingElement: <LoadingView />,
  };

  async componentDidMount() {
    await Modules.initialize(this.context);

    // If we have an entry point file already, we can load now
    if (Files.get(Files.entry())) {
      this._reloadModules();
    }

    notifyStateChange(this.props, 'loading');

    this._handleCodeFetch(this.props.snackCode);

    this.setState(() => ({
      showSplash: false,
    }));
  }

  _handleCodeFetch = async (response: SnackApiCode) => {
    // Update project-level dependency info if given
    let changedDependencies: string[] = [];
    if (response.dependencies) {
      changedDependencies = await Modules.updateProjectDependencies(response.dependencies);
    }

    // Update local files and reload
    Files.updateProjectFiles(response.code);
    const changedPaths = Object.keys(response.code);

    // Reload modules when anything has changed
    if (changedDependencies.length || changedPaths.length) {
      await this._reloadModules({ changedPaths, changedDependencies });
    } else {
      Logger.warn('Code message received but no changes detected, ignoring');
    }

    notifyStateChange(this.props, 'finished');
  };

  // Flush stale modules given local file paths that have changed. If needed, load the root module
  // and construct a React element out of its default export and save it for us to render.
  async _reloadModules({
    changedPaths = [],
    changedDependencies = [],
  }: { changedPaths?: string[]; changedDependencies?: string[] } = {}) {
    Logger.module('Reloading, files changed', changedPaths.concat(changedDependencies), '...');

    let rootElement: React.ReactElement | undefined;
    try {
      const rootModuleUri = 'module://' + Files.entry();

      // Determine if we should render the Expo Router entry component
      const shouldRenderExpoRouter = isExpoRouterEntry(Files.get(Files.entry())?.contents);
      // Determine if the Expo Router entry component is available
      const ExpoRouterEntry = this.context.experimental?.expoRouterEntry;

      // Provide a helpful message when Expo Router was requested but is not available
      if (shouldRenderExpoRouter && !ExpoRouterEntry) {
        Logger.warn('Expo Router entry component is not available, falling back to default export');
      }

      // Handle Expo Router root with a Snack compatible components
      if (shouldRenderExpoRouter && ExpoRouterEntry) {
        // Flush without flushing the root component
        await Modules.flush({ changedPaths, changedUris: [] });

        const ctx = await Modules.load(createVirtualModulePath({ directory: 'module://app' }));
        Logger.info('Updating Expo Router root element');
        rootElement = React.createElement(ExpoRouterEntry, { ctx });
      }
      // Handle normal default exports
      else {
        // Flush with the root component
        await Modules.flush({ changedPaths, changedUris: [rootModuleUri] });
        const hasRootModuleUri = await Modules.has(rootModuleUri);
        if (!hasRootModuleUri) {
          const rootDefaultExport = (await Modules.load(rootModuleUri)).default;
          if (!rootDefaultExport) {
            throw new Error(`No default export of '${Files.entry()}' to render!`);
          }
          Logger.info('Updating root element');
          rootElement = React.createElement(rootDefaultExport);
        }
      }
    } catch (e) {
      Errors.report(e);
    } finally {
      this.setState((state) => ({
        rootElement: rootElement ?? state.rootElement,
        initialLoad: false,
        showSplash: false,
      }));
    }
  }

  render() {
    const { showSplash, rootElement, loadingElement } = this.state;

    if (showSplash) {
      return <AppLoading />;
    }

    // Render root element of the user's application if present, else a loading view. In
    // either case, surround by an `ErrorBoundary` to display errors and allow recovery.
    return (
      <>
        <StatusBar style="dark" />
        <Errors.ErrorBoundary>{rootElement ?? loadingElement}</Errors.ErrorBoundary>
      </>
    );
  }
}
