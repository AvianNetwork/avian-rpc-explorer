#!/usr/bin/env node

"use strict";

const os = require('os');
const path = require('path');
const dotenv = require("dotenv");
const fs = require('fs');

const debug = require("debug");


// start with this, we will update after loading any .env files
const debugDefaultCategories = "avnexp:app,avnexp:error,avnexp:errorVerbose";
debug.enable(debugDefaultCategories);


const debugLog = debug("avnexp:app");
const debugErrorLog = debug("avnexp:error");
const debugPerfLog = debug("avnexp:actionPerformace");
const debugAccessLog = debug("avnexp:access");

const configPaths = [
	path.join(os.homedir(), ".config", "avn-rpc-explorer.env"),
	path.join("/etc", "avn-rpc-explorer", ".env"),
	path.join(process.cwd(), ".env"),
];

debugLog("Searching for config files...");
let configFileLoaded = false;
configPaths.forEach(path => {
	if (fs.existsSync(path)) {
		debugLog(`Config file found at ${path}, loading...`);

		// this does not override any existing env vars
		dotenv.config({ path });

		// we manually set env.DEBUG above (so that app-launch log output is good),
		// so if it's defined in the .env file, we need to manually override
		const config = dotenv.parse(fs.readFileSync(path));
		if (config.DEBUG) {
			process.env.DEBUG = config.DEBUG;
		}

		configFileLoaded = true;

	} else {
		debugLog(`Config file not found at ${path}, continuing...`);
	}
});

if (!configFileLoaded) {
	debugLog("No config files found. Using all defaults.");

	if (!process.env.NODE_ENV) {
		process.env.NODE_ENV = "production";
	}
}

// debug module is already loaded by the time we do dotenv.config
// so refresh the status of DEBUG env var
debug.enable(process.env.DEBUG || debugDefaultCategories);


global.cacheStats = {};



const express = require('express');
const favicon = require('serve-favicon');
const logger = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const session = require("express-session");
const csurf = require("csurf");
const config = require("./app/config.js");
const simpleGit = require('simple-git');
const utils = require("./app/utils.js");
const moment = require("moment");
const Decimal = require('decimal.js');
const avianCore = require("btc-rpc-client");
const pug = require("pug");
const momentDurationFormat = require("moment-duration-format");
const coreApi = require("./app/api/coreApi.js");
const rpcApi = require("./app/api/rpcApi.js");
const coins = require("./app/coins.js");
const axios = require("axios");
const qrcode = require("qrcode");
const addressApi = require("./app/api/addressApi.js");
const electrumAddressApi = require("./app/api/electrumAddressApi.js");
const appStats = require("./app/appStats.js");
const avnQuotes = require("./app/coins/avnQuotes.js");
const avnHolidays = require("./app/coins/avnHolidays.js");
const auth = require('./app/auth.js');
const sso = require('./app/sso.js');
const markdown = require("markdown-it")();
const v8 = require("v8");
var compression = require("compression");

const appUtils = require("@janoside/app-utils");
const s3Utils = appUtils.s3Utils;

let cdnS3Bucket = null;
if (config.cdn.active) {
	cdnS3Bucket = s3Utils.createBucket(config.cdn.s3Bucket, config.cdn.s3BucketPath);
}

require("./app/currencies.js");

const package_json = require('./package.json');
global.appVersion = package_json.version;
global.cacheId = global.appVersion;
debugLog(`Default cacheId '${global.cacheId}'`);

global.avnNodeSemver = "0.0.0";


const baseActionsRouter = require('./routes/baseRouter.js');
const internalApiActionsRouter = require('./routes/internalApiRouter.js');
const apiActionsRouter = require('./routes/apiRouter.js');
const snippetActionsRouter = require('./routes/snippetRouter.js');
const adminActionsRouter = require('./routes/adminRouter.js');
const testActionsRouter = require('./routes/testRouter.js');

const expressApp = express();


const statTracker = require("./app/statTracker.js");

const statsProcessFunction = (name, stats) => {
	appStats.trackAppStats(name, stats);
	
	if (process.env.STATS_API_URL) {
		const data = Object.assign({}, stats);
		data.name = name;

		axios.post(process.env.STATS_API_URL, data)
		.then(res => { /*console.log(res.data);*/ })
		.catch(error => {
			utils.logError("38974wrg9w7dsgfe", error);
		});
	}
};

const processStatsInterval = setInterval(() => {
	statTracker.processAndReset(
		statsProcessFunction,
		statsProcessFunction,
		statsProcessFunction);

}, process.env.STATS_PROCESS_INTERVAL || (5 * 60 * 1000));
	
// Don't keep Node.js process up
processStatsInterval.unref();



const systemMonitor = require("./app/systemMonitor.js");

const normalizeActions = require("./app/normalizeActions.js");
expressApp.use(require("./app/actionPerformanceMonitor.js")(statTracker, {
	ignoredEndsWithActions: "\.js|\.css|\.svg|\.png|\.woff2",
	ignoredStartsWithActions: `${config.baseUrl}snippet`,
	normalizeAction: (action) => {
		return normalizeActions(config.baseUrl, action);
	},
}));

// view engine setup
expressApp.set('views', path.join(__dirname, 'views'));

// ref: https://blog.stigok.com/post/disable-pug-debug-output-with-expressjs-web-app
expressApp.engine('pug', (path, options, fn) => {
	options.debug = false;
	return pug.__express.call(null, path, options, fn);
});

expressApp.set('view engine', 'pug');

if (process.env.NODE_ENV != "local") {
	// enable view cache regardless of env (development/production)
	// ref: https://pugjs.org/api/express.html
	debugLog("Enabling view caching (performance will be improved but template edits will not be reflected)")
	expressApp.enable('view cache');
}

expressApp.use(cookieParser());

expressApp.disable('x-powered-by');


if (process.env.AVNEXP_BASIC_AUTH_PASSWORD) {
	// basic http authentication
	expressApp.use(auth(process.env.AVNEXP_BASIC_AUTH_PASSWORD));

} else if (process.env.AVNEXP_SSO_TOKEN_FILE) {
	// sso authentication
	expressApp.use(sso(process.env.AVNEXP_SSO_TOKEN_FILE, process.env.AVNEXP_SSO_LOGIN_REDIRECT_URL));
}

// uncomment after placing your favicon in /public
//expressApp.use(favicon(__dirname + '/public/favicon.ico'));
//expressApp.use(logger('dev'));
expressApp.use(bodyParser.json());
expressApp.use(bodyParser.urlencoded({ extended: false }));
expressApp.use(session({
	secret: config.cookieSecret,
	resave: false,
	saveUninitialized: false
}));

expressApp.use(compression());

expressApp.use(config.baseUrl, express.static(path.join(__dirname, 'public'), {
	maxAge: 30 * 24 * 60 * 60 * 1000
}));


if (config.baseUrl != '/') {
	expressApp.get('/', (req, res) => res.redirect(config.baseUrl));
}


// if a CDN is configured, these assets will be uploaded at launch, then referenced from there
const cdnItems = [
	[`style/dark.css`, `text/css`, "utf8"],
	[`style/light.css`, `text/css`, "utf8"],
	[`style/highlight.min.css`, `text/css`, "utf8"],
	[`style/dataTables.bootstrap4.min.css`, `text/css`, "utf8"],
	[`style/bootstrap-icons.css`, `text/css`, "utf8"],

	[`js/bootstrap.bundle.min.js`, `text/javascript`, "utf8"],
	[`js/chart.min.js`, `text/javascript`, "utf8"],
	[`js/jquery.min.js`, `text/javascript`, "utf8"],
	[`js/site.js`, `text/javascript`, "utf8"],
	[`js/highlight.pack.js`, `text/javascript`, "utf8"],
	[`js/chartjs-adapter-moment.min.js`, `text/javascript`, "utf8"],
	[`js/jquery.dataTables.min.js`, `text/javascript`, "utf8"],
	[`js/dataTables.bootstrap4.min.js`, `text/javascript`, "utf8"],
	[`js/moment.min.js`, `text/javascript`, "utf8"],
	[`js/sentry.min.js`, `text/javascript`, "utf8"],
	[`js/decimal.js`, `text/javascript`, "utf8"],

	[`img/network-mainnet/logo.svg`, `image/svg+xml`, "utf8"],
	[`img/network-mainnet/coin-icon.svg`, `image/svg+xml`, "utf8"],
	[`img/network-mainnet/apple-touch-icon.png`, `image/png`, "binary"],
	[`img/network-mainnet/favicon-16x16.png`, `image/png`, "binary"],
	[`img/network-mainnet/favicon-32x32.png`, `image/png`, "binary"],
	[`img/network-testnet/logo.svg`, `image/svg+xml`, "utf8"],
	[`img/network-testnet/coin-icon.svg`, `image/svg+xml`, "utf8"],
	[`img/network-signet/logo.svg`, `image/svg+xml`, "utf8"],
	[`img/network-signet/coin-icon.svg`, `image/svg+xml`, "utf8"],
	[`img/network-regtest/logo.svg`, `image/svg+xml`, "utf8"],
	[`img/network-regtest/coin-icon.svg`, `image/svg+xml`, "utf8"],

	[`img/network-mainnet/favicon.ico`, `image/x-icon`, "binary"],
	[`img/network-testnet/favicon.ico`, `image/x-icon`, "binary"],
	[`img/network-signet/favicon.ico`, `image/x-icon`, "binary"],
	[`img/network-regtest/favicon.ico`, `image/x-icon`, "binary"],

	[`font/bootstrap-icons.woff`, `font/woff`, "binary"],
	[`font/bootstrap-icons.woff2`, `font/woff2`, "binary"],

	[`leaflet/leaflet.js`, `text/javascript`, "utf8"],
	[`leaflet/leaflet.css`, `text/css`, "utf8"],
];

const cdnFilepathMap = {};
cdnItems.forEach(item => {
	cdnFilepathMap[item[0]] = true;
});


process.on("unhandledRejection", (reason, p) => {
	debugLog("Unhandled Rejection at: Promise", p, "reason:", reason, "stack:", (reason != null ? reason.stack : "null"));
});

function loadMiningPoolConfigs() {
	debugLog("Loading mining pools config");

	global.miningPoolsConfigs = [];

	var miningPoolsConfigDir = path.join(__dirname, "public", "txt", "mining-pools-configs", global.coinConfig.ticker);

	fs.readdir(miningPoolsConfigDir, function(err, files) {
		if (err) {
			utils.logError("3ufhwehe", err, {configDir:miningPoolsConfigDir, desc:"Unable to scan directory"});

			return;
		}

		files.forEach(function(file) {
			var filepath = path.join(miningPoolsConfigDir, file);

			var contents = fs.readFileSync(filepath, 'utf8');

			global.miningPoolsConfigs.push(JSON.parse(contents));
		});

		for (var i = 0; i < global.miningPoolsConfigs.length; i++) {
			for (var x in global.miningPoolsConfigs[i].payout_addresses) {
				if (global.miningPoolsConfigs[i].payout_addresses.hasOwnProperty(x)) {
					global.specialAddresses[x] = {type:"minerPayout", minerInfo:global.miningPoolsConfigs[i].payout_addresses[x]};
				}
			}
		}
	});
}

async function getSourcecodeProjectMetadata() {
	var options = {
		url: "https://api.github.com/repos/janoside/avn-rpc-explorer",
		headers: {
			'User-Agent': 'request'
		}
	};
	try {
		const response = await axios(options);

		global.sourcecodeProjectMetadata = response.data;

	} catch (err) {
		utils.logError("3208fh3ew7eghfg", err);
		}
}

function loadChangelog() {
	var filename = "CHANGELOG.md";
	
	fs.readFile(path.join(__dirname, filename), 'utf8', function(err, data) {
		if (err) {
			utils.logError("2379gsd7sgd334", err);

		} else {
			global.changelogMarkdown = data;
		}
	});


	var filename = "CHANGELOG-API.md";
	
	fs.readFile(path.join(__dirname, filename), 'utf8', function(err, data) {
		if (err) {
			utils.logError("ouqhuwey723", err);

		} else {
			global.apiChangelogMarkdown = data;
		}
	});
}

function loadHistoricalDataForChain(chain) {
	debugLog(`Loading historical data for chain=${chain}`);

	if (global.coinConfig.historicalData) {
		global.coinConfig.historicalData.forEach(function(item) {
			if (item.chain == chain) {
				if (item.type == "blockheight") {
					global.specialBlocks[item.blockHash] = item;

				} else if (item.type == "tx") {
					global.specialTransactions[item.txid] = item;

				} else if (item.type == "address" || item.address) {
					global.specialAddresses[item.address] = {type:"fun", addressInfo:item};
				}
			}
		});
	}
}

function loadHolidays(chain) {
	debugLog(`Loading holiday data`);

	global.avnHolidays = avnHolidays;
	global.avnHolidays.byDay = {};
	global.avnHolidays.sortedDays = [];
	global.avnHolidays.sortedItems = [...avnHolidays.items];
	global.avnHolidays.sortedItems.sort((a, b) => a.date.localeCompare(b.date));

	global.avnHolidays.items.forEach(function(item) {
		let day = item.date.substring(5);

		if (!global.avnHolidays.sortedDays.includes(day)) {
			global.avnHolidays.sortedDays.push(day);
			global.avnHolidays.sortedDays.sort();
		}

		if (global.avnHolidays.byDay[day] == undefined) {
			global.avnHolidays.byDay[day] = [];
		}

		global.avnHolidays.byDay[day].push(item);
	});
}

function verifyRpcConnection() {
	if (!global.activeBlockchain) {
		debugLog(`Verifying RPC connection...`);

		// normally in application code we target coreApi, but here we're trying to
		// verify the RPC connection so we target rpcApi directly and include
		// the second parameter "verifyingConnection=true", to bypass a
		// fail-if-were-not-connected check

		Promise.all([
			rpcApi.getRpcData("getnetworkinfo", true),
			rpcApi.getRpcData("getblockchaininfo", true),
		]).then(([ getnetworkinfo, getblockchaininfo ]) => {
			global.activeBlockchain = getblockchaininfo.chain;

			// we've verified rpc connection, no need to keep trying
			clearInterval(global.verifyRpcConnectionIntervalId);

			onRpcConnectionVerified(getnetworkinfo, getblockchaininfo);

		}).catch(function(err) {
			utils.logError("32ugegdfsde", err);
		});
	}
}

async function onRpcConnectionVerified(getnetworkinfo, getblockchaininfo) {
	// localservicenames introduced in 0.19
	var services = getnetworkinfo.localservicesnames ? ("[" + getnetworkinfo.localservicesnames.join(", ") + "]") : getnetworkinfo.localservices;

	global.rpcConnected = true;
	global.getnetworkinfo = getnetworkinfo;

	if (getblockchaininfo.pruned) {
		global.prunedBlockchain = true;
		global.pruneHeight = getblockchaininfo.pruneheight;
	}

	var avianCoreVersionRegex = /^.*\/Avian\:(.*)\/.*$/;

	var match = avianCoreVersionRegex.exec(getnetworkinfo.subversion);
	if (match) {
		global.avnNodeVersion = match[1];

		var semver4PartRegex = /^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)$/;

		var semver4PartMatch = semver4PartRegex.exec(global.avnNodeVersion);
		if (semver4PartMatch) {
			var p0 = semver4PartMatch[1];
			var p1 = semver4PartMatch[2];
			var p2 = semver4PartMatch[3];
			var p3 = semver4PartMatch[4];

			// drop last segment, which usually indicates a bug fix release which is (hopefully) irrelevant for RPC API versioning concerns
			global.avnNodeSemver = `${p0}.${p1}.${p2}`;

		} else {
			var semver3PartRegex = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;

			var semver3PartMatch = semver3PartRegex.exec(global.avnNodeVersion);
			if (semver3PartMatch) {
				var p0 = semver3PartMatch[1];
				var p1 = semver3PartMatch[2];
				var p2 = semver3PartMatch[3];

				global.avnNodeSemver = `${p0}.${p1}.${p2}`;

			} else {
				// short-circuit: force all RPC calls to pass their version checks - this will likely lead to errors / instability / unexpected results
				global.avnNodeSemver = "1000.1000.0"
			}
		}
	} else {
		// short-circuit: force all RPC calls to pass their version checks - this will likely lead to errors / instability / unexpected results
		global.avnNodeSemver = "1000.1000.0"

		debugErrorLog(`Unable to parse node version string: ${getnetworkinfo.subversion} - RPC versioning will likely be unreliable. Is your node a version of Avian Core?`);
	}
	
	debugLog(`RPC Connected: version=${getnetworkinfo.version} subversion=${getnetworkinfo.subversion}, parsedVersion(used for RPC versioning)=${global.avnNodeSemver}, protocolversion=${getnetworkinfo.protocolversion}, chain=${getblockchaininfo.chain}, services=${services}`);

	
	// load historical/fun items for this chain
	loadHistoricalDataForChain(global.activeBlockchain);

	loadHolidays();

	if (global.activeBlockchain == "main") {
		loadDifficultyHistory(getblockchaininfo.blocks);

		// refresh difficulty history periodically
		// TODO: refresh difficulty history when there's a new block and height % 2016 == 0
		setInterval(loadDifficultyHistory, 15 * 60 * 1000);


		if (global.exchangeRates == null) {
			utils.refreshExchangeRates();
		}

		// refresh exchange rate periodically
		setInterval(utils.refreshExchangeRates, 1800000);
	}


	// 1d / 7d volume
	refreshNetworkVolumes();
	setInterval(refreshNetworkVolumes, 30 * 60 * 1000);


	await assessTxindexAvailability();


	// UTXO pull
	refreshUtxoSetSummary();
	setInterval(refreshUtxoSetSummary, 30 * 60 * 1000);



	if (false) {
		var zmq = require("zeromq");
		var sock = zmq.socket("sub");

		sock.connect("tcp://192.168.1.1:28333");
		console.log("Worker connected to port 28333");

		sock.on("message", function(topic, message) {
			console.log(Buffer.from(topic).toString("ascii") + " - " + Buffer.from(message).toString("hex"));
		});

		//sock.subscribe('rawtx');
	}
}

async function loadDifficultyHistory(tipBlockHeight=null) {
	if (!tipBlockHeight) {
		let getblockchaininfo = await coreApi.getBlockchainInfo();

		tipBlockHeight = getblockchaininfo.blocks;
	}

	if (config.slowDeviceMode) {
		debugLog("Skipping performance-intensive task: load difficulty history. This is skipped due to the flag 'slowDeviceMode' which defaults to 'true' to protect slow nodes. Set this flag to 'false' to enjoy difficulty history details.");

		return;
	}

	let height = 0;
	let heights = [];

	while (height <= tipBlockHeight) {
		heights.push(height);
		height += global.coinConfig.difficultyAdjustmentBlockCount;
	}

	global.difficultyHistory = await coreApi.getDifficultyByBlockHeights(heights);
	
	global.athDifficulty_x16rt = 0;
	global.athDifficulty_minotaurx = 0;

	for (let i = 0; i < heights.length; i++) {
		if (global.difficultyHistory[`${heights[i]}`].difficulty_x16rt > global.athDifficulty_x16rt) {	
			global.athDifficulty_x16rt = global.difficultyHistory[heights[i]].difficulty_x16rt;
		}
	}

	for (let i = 0; i < heights.length; i++) {
		if (global.difficultyHistory[`${heights[i]}`].difficulty_minotaurx > global.athDifficulty_minotaurx) {	
			global.athDifficulty_minotaurx = global.difficultyHistory[heights[i]].difficulty_minotaurx;
		}
	}

	debugLog("x16rt ATH difficulty: " + global.athDifficulty_x16rt);
	debugLog("minotaurx ATH difficulty: " + global.athDifficulty_minotaurx);

}

var txindexCheckCount = 0;
async function assessTxindexAvailability() {
	try {
		debugLog("txindex check: trying txid lookup");

		try {
			// lookup a known TXID as a test for whether txindex is available
			let knownTx = await coreApi.getRawTransaction(coinConfig.knownTransactionsByNetwork[global.activeBlockchain]);

			// if we get here without an error being thrown, we know we're able to look up by txid
			// thus, txindex is available
			global.txindexAvailable = true;

			debugLog("txindex check: available! (no getindexinfo)");

		} catch (e) {
			// here we were unable to query by txid, so we believe txindex is unavailable
			global.txindexAvailable = false;

			debugLog("txindex check: unavailable");
		}
	} catch (e) {
		utils.logError("o2328ryw8wsde", e);

		var retryTime = parseInt(Math.min(15 * 60 * 1000, 1000 * 10 * Math.pow(2, txindexCheckCount)));
		txindexCheckCount++;

		debugLog(`txindex check: error in rpc getindexinfo; will try again in ${retryTime}ms`);

		// try again in 5 mins
		setTimeout(assessTxindexAvailability, retryTime);
	}
}

async function refreshUtxoSetSummary() {
	if (config.slowDeviceMode) {
		if (!global.getindexinfo || !global.getindexinfo.coinstatsindex) {
			global.utxoSetSummary = null;
			global.utxoSetSummaryPending = false;

			debugLog("Skipping performance-intensive task: fetch UTXO set summary. This is skipped due to the flag 'slowDeviceMode' which defaults to 'true' to protect slow nodes. Set this flag to 'false' to enjoy UTXO set summary details.");

			return;
		}
	}

	// flag that we're working on calculating UTXO details (to differentiate cases where we don't have the details and we're not going to try computing them)
	global.utxoSetSummaryPending = true;

	global.utxoSetSummary = await coreApi.getUtxoSetSummary(true, false);

	debugLog("Refreshed utxo summary: " + JSON.stringify(global.utxoSetSummary));
}

function refreshNetworkVolumes() {
	if (config.slowDeviceMode) {
		debugLog("Skipping performance-intensive task: fetch last 24 hrs of blockstats to calculate transaction volume. This is skipped due to the flag 'slowDeviceMode' which defaults to 'true' to protect slow nodes. Set this flag to 'false' to enjoy UTXO set summary details.");

		return;
	}

	var cutoff1d = new Date().getTime() - (60 * 60 * 24 * 1000);
	var cutoff7d = new Date().getTime() - (60 * 60 * 24 * 7 * 1000);

	coreApi.getBlockchainInfo().then(function(result) {
		var promises = [];

		var blocksPerDay = 144 + 20; // 20 block padding

		for (var i = 0; i < (blocksPerDay * 1); i++) {
			if (result.blocks - i >= 0) {
				promises.push(coreApi.getBlockStatsByHeight(result.blocks - i));
			}
		}

		var startBlock = result.blocks;

		var endBlock1d = result.blocks;
		var endBlock7d = result.blocks;

		var endBlockTime1d = 0;
		var endBlockTime7d = 0;

		Promise.all(promises).then(function(results) {
			var volume1d = new Decimal(0);
			var volume7d = new Decimal(0);

			var blocks1d = 0;
			var blocks7d = 0;

			if (results && results.length > 0 && results[0] != null) {
				for (var i = 0; i < results.length; i++) {
					if (results[i].time * 1000 > cutoff1d) {
						volume1d = volume1d.plus(new Decimal(results[i].total_out));
						volume1d = volume1d.plus(new Decimal(results[i].subsidy));
						volume1d = volume1d.plus(new Decimal(results[i].totalfee));
						blocks1d++;

						endBlock1d = results[i].height;
						endBlockTime1d = results[i].time;
					}

					if (results[i].time * 1000 > cutoff7d) {
						volume7d = volume7d.plus(new Decimal(results[i].total_out));
						volume7d = volume7d.plus(new Decimal(results[i].subsidy));
						volume7d = volume7d.plus(new Decimal(results[i].totalfee));
						blocks7d++;

						endBlock7d = results[i].height;
						endBlockTime7d = results[i].time;
					}
				}

				volume1d = volume1d.dividedBy(coinConfig.baseCurrencyUnit.multiplier);
				volume7d = volume7d.dividedBy(coinConfig.baseCurrencyUnit.multiplier);

				global.networkVolume = {d1:{amt:volume1d, blocks:blocks1d, startBlock:startBlock, endBlock:endBlock1d, startTime:results[0].time, endTime:endBlockTime1d}};

				debugLog(`Network volume: ${JSON.stringify(global.networkVolume)}`);

			} else {
				debugLog("Unable to load network volume, likely due to aviand version older than 0.17.0 (the first version to support getblockstats).");
			}
		});
	});
}


expressApp.onStartup = async () => {
	global.appStartTime = new Date().getTime();
	
	global.config = config;
	global.coinConfig = coins[config.coin];
	global.coinConfigs = coins;

	global.specialTransactions = {};
	global.specialBlocks = {};
	global.specialAddresses = {};

	loadChangelog();

	global.nodeVersion = process.version;
	debugLog(`Environment(${expressApp.get("env")}) - Node: ${process.version}, Platform: ${process.platform}, Versions: ${JSON.stringify(process.versions)}`);


	// dump "startup" heap after 5sec
	if (false) {
		(function () {
			var callback = function() {
				debugLog("Waited 5 sec after startup, now dumping 'startup' heap...");

				const filename = `./heapDumpAtStartup-${Date.now()}.heapsnapshot`;
				const heapdumpStream = v8.getHeapSnapshot();
				const fileStream = fs.createWriteStream(filename);
				heapdumpStream.pipe(fileStream);

				debugLog("Heap dump at startup written to", filename);
			};

			setTimeout(callback, 5000);
		})();
	}
	

	if (global.sourcecodeVersion == null && fs.existsSync('.git')) {
		try {
			let log = await simpleGit(".").log(["-n 1"]);

			global.sourcecodeVersion = log.all[0].hash.substring(0, 10);
			global.sourcecodeDate = log.all[0].date.substring(0, "0000-00-00".length);

			global.cacheId = `${global.sourcecodeDate}-${global.sourcecodeVersion}`;

			debugLog(`Using sourcecode metadata as cacheId: '${global.cacheId}'`);

			debugLog(`Starting ${global.coinConfig.ticker} RPC Explorer, v${global.appVersion} (commit: '${global.sourcecodeVersion}', date: ${global.sourcecodeDate}) at http://${config.host}:${config.port}${config.baseUrl}`);


		} catch (err) {
			utils.logError("3fehge9ee", err, {desc:"Error accessing git repo"});

			global.cacheId = global.appVersion;
			debugLog(`Error getting sourcecode version, continuing to use default cacheId '${global.cacheId}'`);

			debugLog(`Starting ${global.coinConfig.ticker} RPC Explorer, v${global.appVersion} (code: unknown commit) at http://${config.host}:${config.port}${config.baseUrl}`);
		}
		
		expressApp.continueStartup();

	} else {
		global.cacheId = global.appVersion;
		debugLog(`No sourcecode version available, continuing to use default cacheId '${global.cacheId}'`);

		debugLog(`Starting ${global.coinConfig.ticker} RPC Explorer, v${global.appVersion} at http://${config.host}:${config.port}${config.baseUrl}`);

		expressApp.continueStartup();
	}

	if (config.cdn.active && config.cdn.s3Bucket) {
		debugLog(`Configuring CDN assets; uploading ${cdnItems.length} assets to S3...`);

		const s3Path = (filepath) => { return `${global.cacheId}/${filepath}`; }

		const uploadedItems = [];
		const existingItems = [];
		const errorItems = [];

		const uploadAssetIfNeeded = async (filepath, contentType, encoding) => {
			try {
				let absoluteFilepath = path.join(process.cwd(), "public", filepath);
				let s3path = s3Path(filepath);
				
				const existingAsset = await cdnS3Bucket.get(s3path);

				if (existingAsset) {
					existingItems.push(filepath);

					//debugLog(`Asset ${filepath} already in S3, skipping upload.`);

				} else {
					let fileData = fs.readFileSync(absoluteFilepath, {encoding: encoding, flag:'r'});
					let fileBuffer = Buffer.from(fileData, encoding);

					let options = {
						"ContentType": contentType,
						"CacheControl": "max-age=315360000"
					};

					await cdnS3Bucket.put(fileBuffer, s3path, options);

					uploadedItems.push(filepath);

					//debugLog(`Uploaded ${filepath} to S3.`);
				}
			} catch (e) {
				errorItems.push(filepath);

				debugErrorLog(`Error uploading asset to S3: ${JSON.stringify(filepath)}`, e);
			}
		};

		const promises = [];
		for (let i = 0; i < cdnItems.length; i++) {
			let item = cdnItems[i];

			let filepath = item[0];
			let contentType = item[1];
			let encoding = item[2];

			promises.push(uploadAssetIfNeeded(filepath, contentType, encoding));
		}

		await utils.awaitPromises(promises);

		debugLog(`Done uploading assets to S3:\n\tAlready present: ${existingItems.length}\n\tNewly uploaded: ${uploadedItems.length}\n\tError items: ${errorItems.length}`);
	}
}

expressApp.continueStartup = function() {
	var rpcCred = config.credentials.rpc;
	debugLog(`Connecting to RPC node at ${rpcCred.host}:${rpcCred.port}`);

	var rpcClientProperties = {
		host: rpcCred.host,
		port: rpcCred.port,
		username: rpcCred.username,
		password: rpcCred.password,
		timeout: rpcCred.timeout
	};

	global.rpcClient = new avianCore(rpcClientProperties);

	var rpcClientNoTimeoutProperties = {
		host: rpcCred.host,
		port: rpcCred.port,
		username: rpcCred.username,
		password: rpcCred.password,
		timeout: 0
	};

	global.rpcClientNoTimeout = new avianCore(rpcClientNoTimeoutProperties);

	// default values - after we connect via RPC, we update these
	global.txindexAvailable = false;
	global.prunedBlockchain = false;
	global.pruneHeight = -1;


	// keep trying to verify rpc connection until we succeed
	// note: see verifyRpcConnection() for associated clearInterval() after success
	verifyRpcConnection();
	global.verifyRpcConnectionIntervalId = setInterval(verifyRpcConnection, 30000);


	if (config.addressApi) {
		var supportedAddressApis = addressApi.getSupportedAddressApis();
		if (!supportedAddressApis.includes(config.addressApi)) {
			utils.logError("32907ghsd0ge", `Unrecognized value for AVNEXP_ADDRESS_API: '${config.addressApi}'. Valid options are: ${supportedAddressApis}`);
		}

		if (config.addressApi == "electrum" || config.addressApi == "electrumx") {
			if (config.electrumServers && config.electrumServers.length > 0) {
				electrumAddressApi.connectToServers().then(function() {
					global.electrumAddressApi = electrumAddressApi;
					
				}).catch(function(err) {
					utils.logError("31207ugf4e0fed", err, {electrumServers:config.electrumServers});
				});
			} else {
				utils.logError("327hs0gde", "You must set the 'AVNEXP_ELECTRUM_SERVERS' environment variable when AVNEXP_ADDRESS_API=electrum.");
			}
		}
	}


	loadMiningPoolConfigs();


	if (config.demoSite) {
		getSourcecodeProjectMetadata();
		setInterval(getSourcecodeProjectMetadata, 3600000);
	}


	utils.logMemoryUsage();
	setInterval(utils.logMemoryUsage, 5000);
};

expressApp.use(function(req, res, next) {
	req.startTime = Date.now();

	next();
});

expressApp.use(function(req, res, next) {
	// make session available in templates
	res.locals.session = req.session;

	if (config.credentials.rpc && req.session.host == null) {
		req.session.host = config.credentials.rpc.host;
		req.session.port = config.credentials.rpc.port;
		req.session.username = config.credentials.rpc.username;
	}

	var userAgent = req.headers['user-agent'];
	var crawler = utils.getCrawlerFromUserAgentString(userAgent);
	if (crawler) {
		res.locals.crawlerBot = true;
	}

	// make a bunch of globals available to templates
	res.locals.config = global.config;
	res.locals.coinConfig = global.coinConfig;
	res.locals.activeBlockchain = global.activeBlockchain;
	res.locals.exchangeRates = global.exchangeRates;
	res.locals.utxoSetSummary = global.utxoSetSummary;
	res.locals.utxoSetSummaryPending = global.utxoSetSummaryPending;
	res.locals.networkVolume = global.networkVolume;
	
	res.locals.host = req.session.host;
	res.locals.port = req.session.port;

	res.locals.genesisBlockHash = coreApi.getGenesisBlockHash();
	res.locals.genesisCoinbaseTransactionId = coreApi.getGenesisCoinbaseTransactionId();

	res.locals.pageErrors = [];


	if (!req.session.userSettings) {
		req.session.userSettings = Object.create(null);

		const cookieSettings = JSON.parse(req.cookies["user-settings"] || "{}");
		for (const [key, value] of Object.entries(cookieSettings)) {
			req.session.userSettings[key] = value;
		}
	}

	const userSettings = req.session.userSettings;
	res.locals.userSettings = userSettings;

	// set defaults
	userSettings.displayCurrency = (userSettings.displayCurrency || config.displayDefaults.displayCurrency);
	userSettings.localCurrency = (userSettings.localCurrency || config.displayDefaults.localCurrency);
	userSettings.uiTimezone = (userSettings.uiTimezone || config.displayDefaults.timezone);
	userSettings.uiTheme = (userSettings.uiTheme || config.displayDefaults.theme);


	// make available in templates
	res.locals.displayCurrency = userSettings.displayCurrency;
	res.locals.localCurrency = userSettings.localCurrency;
	res.locals.uiTimezone = userSettings.uiTimezone;
	res.locals.uiTheme = userSettings.uiTheme;
	res.locals.userTzOffset = userSettings.userTzOffset || "unset";
	res.locals.browserTzOffset = userSettings.browserTzOffset || "0";


	if (!["/", "/connect"].includes(req.originalUrl)) {
		if (utils.redirectToConnectPageIfNeeded(req, res)) {
			return;
		}
	}

	if (req.session.userMessage) {
		res.locals.userMessage = req.session.userMessage;
		
		if (req.session.userMessageType) {
			res.locals.userMessageType = req.session.userMessageType;
			
		} else {
			res.locals.userMessageType = "warning";
		}

		req.session.userMessage = null;
		req.session.userMessageType = null;
	}

	if (req.session.query) {
		res.locals.query = req.session.query;

		req.session.query = null;
	}


	if (!global.rpcConnected) {
		res.status(500);
		res.render('error', {
			errorType: "noRpcConnection"
		});

		return;
	}
	

	// make some var available to all request
	// ex: req.cheeseStr = "cheese";

	next();
});

expressApp.use(csurf(), (req, res, next) => {
	res.locals.csrfToken = req.csrfToken();

	next();
});

expressApp.use(config.baseUrl, baseActionsRouter);
expressApp.use(config.baseUrl + 'internal-api/', internalApiActionsRouter);
expressApp.use(config.baseUrl + 'api/', apiActionsRouter);
expressApp.use(config.baseUrl + 'snippet/', snippetActionsRouter);
expressApp.use(config.baseUrl + 'admin/', adminActionsRouter);

if (expressApp.get("env") === "local") {
	expressApp.use(config.baseUrl + 'test/', testActionsRouter);
}


expressApp.use(function(req, res, next) {
	var time = Date.now() - req.startTime;
	var userAgent = req.headers['user-agent'];
	var crawler = utils.getCrawlerFromUserAgentString(userAgent);
	let ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();

	if (crawler) {
		debugAccessLog(`Finished action '${req.path}' (${res.statusCode}) in ${time}ms for crawler '${crawler}' / '${userAgent}', ip=${ip}`);

	} else {
		debugAccessLog(`Finished action '${req.path}' (${res.statusCode}) in ${time}ms for UA '${userAgent}', ip=${ip}`);
	}

	if (!res.headersSent) {
		next();
	}
});

/// catch 404 and forwarding to error handler
expressApp.use(function(req, res, next) {
	var err = new Error(`Not Found: ${req ? req.url : 'unknown url'}`);
	err.status = 404;

	next(err);
});

/// error handlers

const sharedErrorHandler = (req, err) => {
	if (err && err.message && err.message.includes("Not Found")) {
		const path = err.toString().substring(err.toString().lastIndexOf(" ") + 1);
		const userAgent = req.headers['user-agent'];
		const crawler = utils.getCrawlerFromUserAgentString(userAgent);
		const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress; 

		const attributes = { path:path };

		if (crawler) {
			attributes.crawler = crawler;
		}

		debugErrorLog(`404 NotFound: path=${path}, ip=${ip}, userAgent=${userAgent} (crawler=${(crawler != null)}${crawler ? crawler : ""})`);

		utils.logError(`NotFound`, err, attributes, false);

	} else {
		utils.logError("ExpressUncaughtError", err);
	}
};

// development error handler
// will print stacktrace
if (expressApp.get("env") === "development" || expressApp.get("env") === "local") {
	expressApp.use(function(err, req, res, next) {
		if (err) {
			sharedErrorHandler(req, err);
		}

		res.status(err.status || 500);
		res.render('error', {
			message: err.message,
			error: err
		});
	});
}

// production error handler
// no stacktraces leaked to user
expressApp.use(function(err, req, res, next) {
	if (err) {
		sharedErrorHandler(req, err);
	}

	res.status(err.status || 500);
	res.render('error', {
		message: err.message,
		error: {}
	});
});

expressApp.locals.moment = moment;
expressApp.locals.Decimal = Decimal;
expressApp.locals.utils = utils;
expressApp.locals.markdown = src => markdown.render(src);

expressApp.locals.assetUrl = (path) => {
	// trim off leading "./"
	let normalizedPath = path.substring(2);

	//console.log("assetUrl: " + path + " -> " + normalizedPath);

	if (config.cdn.active && cdnFilepathMap[normalizedPath]) {
		return `${config.cdn.baseUrl}/${global.cacheId}/${normalizedPath}`;

	} else {
		return `${path}?v=${global.cacheId}`;
	}
};

// debug setting to skip js/css integrity checks
const skipIntegrityChecks = false;
const resourceIntegrityHashes = JSON.parse(fs.readFileSync(path.join(process.cwd(), "public/txt/resource-integrity.json")));

expressApp.locals.assetIntegrity = (filename) => {
	if (!skipIntegrityChecks && resourceIntegrityHashes[filename]) {
		return resourceIntegrityHashes[filename];

	} else {
		return "";
	}
};


module.exports = expressApp;
