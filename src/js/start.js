/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2014-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

'use strict';

/******************************************************************************/

// Load all: executed once.

{
// >>>>> start of local scope

const µb = µBlock;

/******************************************************************************/

vAPI.app.onShutdown = function() {
    const µb = µBlock;
    µb.staticFilteringReverseLookup.shutdown();
    µb.assets.updateStop();
    µb.staticNetFilteringEngine.reset();
    µb.staticExtFilteringEngine.reset();
    µb.sessionFirewall.reset();
    µb.permanentFirewall.reset();
    µb.sessionURLFiltering.reset();
    µb.permanentURLFiltering.reset();
    µb.sessionSwitches.reset();
    µb.permanentSwitches.reset();
};

/******************************************************************************/

// Final initialization steps after all needed assets are in memory.
// - Initialize internal state with maybe already existing tabs.
// - Schedule next update operation.

const onAllReady = function() {
    µb.webRequest.start();

    // Ensure that the resources allocated for decompression purpose (likely
    // large buffers) are garbage-collectable immediately after launch.
    // Otherwise I have observed that it may take quite a while before the
    // garbage collection of these resources kicks in. Relinquishing as soon
    // as possible ensure minimal memory usage baseline.
    µb.lz4Codec.relinquish();

    initializeTabs();

    // https://github.com/chrisaljoudi/uBlock/issues/184
    //   Check for updates not too far in the future.
    µb.assets.addObserver(µb.assetObserver.bind(µb));
    µb.scheduleAssetUpdater(
        µb.userSettings.autoUpdate
            ? µb.hiddenSettings.autoUpdateDelayAfterLaunch * 1000
            : 0
    );

    // vAPI.cloud is optional.
    if ( µb.cloudStorageSupported ) {
        vAPI.cloud.start([
            'tpFiltersPane',
            'myFiltersPane',
            'myRulesPane',
            'whitelistPane'
        ]);
    }

    µb.contextMenu.update(null);
    µb.firstInstall = false;

    // https://github.com/uBlockOrigin/uBlock-issues/issues/717
    //   Prevent the extensions from being restarted mid-session.
    browser.runtime.onUpdateAvailable.addListener(details => {
        const toInt = vAPI.app.intFromVersion;
        if (
            µBlock.hiddenSettings.extensionUpdateForceReload === true ||
            toInt(details.version) <= toInt(vAPI.app.version)
        ) {
            vAPI.app.restart();
        }
    });

    log.info(`All ready ${Date.now()-vAPI.T0} ms after launch`);
};

/******************************************************************************/

// This is called only once, when everything has been loaded in memory after
// the extension was launched. It can be used to inject content scripts
// in already opened web pages, to remove whatever nuisance could make it to
// the web pages before uBlock was ready.

const initializeTabs = function() {
    const handleScriptResponse = function(tabId, results) {
        if (
            Array.isArray(results) === false ||
            results.length === 0 ||
            results[0] !== true
        ) {
            return;
        }
        // Inject dclarative content scripts programmatically.
        const manifest = chrome.runtime.getManifest();
        if ( manifest instanceof Object === false ) { return; }
        for ( const contentScript of manifest.content_scripts ) {
            for ( const file of contentScript.js ) {
                vAPI.tabs.injectScript(tabId, {
                    file: file,
                    allFrames: contentScript.all_frames,
                    runAt: contentScript.run_at
                });
            }
        }
    };
    const bindToTabs = function(tabs) {
        for ( const tab of tabs  ) {
            µb.tabContextManager.commit(tab.id, tab.url);
            µb.bindTabToPageStats(tab.id);
            // https://github.com/chrisaljoudi/uBlock/issues/129
            //   Find out whether content scripts need to be injected
            //   programmatically. This may be necessary for web pages which
            //   were loaded before uBO launched.
            if ( /^https?:\/\//.test(tab.url) === false ) { continue; }
            vAPI.tabs.injectScript(
                tab.id,
                { file: 'js/scriptlets/should-inject-contentscript.js' },
                handleScriptResponse.bind(null, tab.id)
            );
        }
    };

    browser.tabs.query({ url: '<all_urls>' }, bindToTabs);
};

/******************************************************************************/

// Filtering engines dependencies:
// - PSL

const onPSLReady = function() {
    log.info(`PSL ready ${Date.now()-vAPI.T0} ms after launch`);

    µb.selfieManager.load().then(valid => {
        if ( valid === true ) {
            log.info(`Selfie ready ${Date.now()-vAPI.T0} ms after launch`);
            onAllReady();
            return;
        }
        µb.loadFilterLists(( ) => {
            log.info(`Filter lists ready ${Date.now()-vAPI.T0} ms after launch`);
            onAllReady();
        });
    });
};

/******************************************************************************/

const onCommandShortcutsReady = function(commandShortcuts) {
    if ( Array.isArray(commandShortcuts) === false ) { return; }
    µb.commandShortcuts = new Map(commandShortcuts);
    if ( µb.canUpdateShortcuts === false ) { return; }
    for ( const entry of commandShortcuts ) {
        vAPI.commands.update({ name: entry[0], shortcut: entry[1] });
    }
};

/******************************************************************************/

// To bring older versions up to date

const onVersionReady = function(lastVersion) {
    if ( lastVersion === vAPI.app.version ) { return; }

    // Since built-in resources may have changed since last version, we
    // force a reload of all resources.
    µb.redirectEngine.invalidateResourcesSelfie();

    const lastVersionInt = vAPI.app.intFromVersion(lastVersion);

    // https://github.com/uBlockOrigin/uBlock-issues/issues/494
    //   Remove useless per-site switches.
    if ( lastVersionInt <= 1019003007 ) {
        µb.sessionSwitches.toggle('no-scripting', 'behind-the-scene', 0);
        µb.permanentSwitches.toggle('no-scripting', 'behind-the-scene', 0);
        µb.saveHostnameSwitches();
    }

    vAPI.storage.set({ version: vAPI.app.version });
};

/******************************************************************************/

// https://github.com/chrisaljoudi/uBlock/issues/226
// Whitelist in memory.
// Whitelist parser needs PSL to be ready.
// gorhill 2014-12-15: not anymore

const onNetWhitelistReady = function(netWhitelistRaw) {
    if ( typeof netWhitelistRaw === 'string' ) {
        netWhitelistRaw = netWhitelistRaw.split('\n');
    }
    µb.netWhitelist = µb.whitelistFromArray(netWhitelistRaw);
    µb.netWhitelistModifyTime = Date.now();
};

/******************************************************************************/

// User settings are in memory

const onUserSettingsReady = function(fetched) {
    log.info(`User settings ready ${Date.now()-vAPI.T0} ms after launch`);

    const userSettings = µb.userSettings;

    fromFetch(userSettings, fetched);

    if ( µb.privacySettingsSupported ) {
        vAPI.browserSettings.set({
            'hyperlinkAuditing': !userSettings.hyperlinkAuditingDisabled,
            'prefetching': !userSettings.prefetchingDisabled,
            'webrtcIPAddress': !userSettings.webrtcIPAddressHidden
        });
    }

    µb.permanentFirewall.fromString(fetched.dynamicFilteringString);
    µb.sessionFirewall.assign(µb.permanentFirewall);
    µb.permanentURLFiltering.fromString(fetched.urlFilteringString);
    µb.sessionURLFiltering.assign(µb.permanentURLFiltering);
    µb.permanentSwitches.fromString(fetched.hostnameSwitchesString);
    µb.sessionSwitches.assign(µb.permanentSwitches);
};

/******************************************************************************/

// Housekeeping, as per system setting changes

const onSystemSettingsReady = function(fetched) {
    let mustSaveSystemSettings = false;
    if ( fetched.compiledMagic !== µb.systemSettings.compiledMagic ) {
        µb.assets.remove(/^compiled\//);
        mustSaveSystemSettings = true;
    }
    if ( fetched.selfieMagic !== µb.systemSettings.selfieMagic ) {
        mustSaveSystemSettings = true;
    }
    if ( mustSaveSystemSettings ) {
        fetched.selfie = null;
        µb.selfieManager.destroy();
        vAPI.storage.set(µb.systemSettings);
    }
};

/******************************************************************************/

const onFirstFetchReady = function(fetched) {
    log.info(`First fetch ready ${Date.now()-vAPI.T0} ms after launch`);

    // https://github.com/uBlockOrigin/uBlock-issues/issues/507
    //   Firefox-specific: somehow `fetched` is undefined under certain
    //   circumstances even though we asked to load with default values.
    if ( fetched instanceof Object === false ) {
        fetched = createDefaultProps();
    }

    // https://github.com/gorhill/uBlock/issues/747
    µb.firstInstall = fetched.version === '0.0.0.0';

    // Order is important -- do not change:
    onSystemSettingsReady(fetched);
    fromFetch(µb.localSettings, fetched);
    onUserSettingsReady(fetched);
    fromFetch(µb.restoreBackupSettings, fetched);
    onNetWhitelistReady(fetched.netWhitelist);
    onVersionReady(fetched.version);
    onCommandShortcutsReady(fetched.commandShortcuts);

    µb.loadPublicSuffixList().then(( ) => {
        onPSLReady();
    });
};

/******************************************************************************/

const toFetch = function(from, fetched) {
    for ( const k in from ) {
        if ( from.hasOwnProperty(k) === false ) { continue; }
        fetched[k] = from[k];
    }
};

const fromFetch = function(to, fetched) {
    for ( const k in to ) {
        if ( to.hasOwnProperty(k) === false ) { continue; }
        if ( fetched.hasOwnProperty(k) === false ) { continue; }
        to[k] = fetched[k];
    }
};

const createDefaultProps = function() {
    const fetchableProps = {
        'commandShortcuts': [],
        'compiledMagic': 0,
        'dynamicFilteringString': [
            'behind-the-scene * * noop',
            'behind-the-scene * image noop',
            'behind-the-scene * 3p noop',
            'behind-the-scene * inline-script noop',
            'behind-the-scene * 1p-script noop',
            'behind-the-scene * 3p-script noop',
            'behind-the-scene * 3p-frame noop'
        ].join('\n'),
        'urlFilteringString': '',
        'hostnameSwitchesString': [
            'no-large-media: behind-the-scene false',
        ].join('\n'),
        'lastRestoreFile': '',
        'lastRestoreTime': 0,
        'lastBackupFile': '',
        'lastBackupTime': 0,
        'netWhitelist': µb.netWhitelistDefault,
        'selfieMagic': 0,
        'version': '0.0.0.0'
    };
    toFetch(µb.localSettings, fetchableProps);
    toFetch(µb.userSettings, fetchableProps);
    toFetch(µb.restoreBackupSettings, fetchableProps);
    return fetchableProps;
};

/******************************************************************************/

const onHiddenSettingsReady = function() {
    return µb.cacheStorage.select(
        µb.hiddenSettings.cacheStorageAPI
    ).then(backend => {
        log.info(`Backend storage for cache will be ${backend}`);
    });
};

/******************************************************************************/

// TODO(seamless migration):
// Eventually selected filter list keys will be loaded as a fetchable
// property. Until then we need to handle backward and forward
// compatibility, this means a special asynchronous call to load selected
// filter lists.

const onAdminSettingsRestored = function() {
    log.info(`Admin settings ready ${Date.now()-vAPI.T0} ms after launch`);

    Promise.all([
        µb.loadHiddenSettings().then(( ) =>
            onHiddenSettingsReady()
        ),
        µb.loadSelectedFilterLists(),
    ]).then(( ) => {
        log.info(`List selection ready ${Date.now()-vAPI.T0} ms after launch`);
        vAPI.storage.get(createDefaultProps(), onFirstFetchReady);
    });
};

/******************************************************************************/

// https://github.com/gorhill/uBlock/issues/531
µb.restoreAdminSettings().then(( ) => {
    onAdminSettingsRestored();
});

// <<<<< end of local scope
}
