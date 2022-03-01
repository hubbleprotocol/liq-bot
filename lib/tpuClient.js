"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TpuConnection = exports.LeaderTpuService = exports.TpuClient = exports.RecentLeaderSlots = exports.MAX_FANOUT_SLOTS = exports.DEFAULT_FANOUT_SLOTS = exports.MAX_SLOT_SKIP_DISTANCE = exports.LeaderTpuCache = void 0;
const web3_js_1 = require("@solana/web3.js");
const denque_1 = __importDefault(require("denque"));
const dgram_1 = __importDefault(require("dgram"));
const bs58_1 = __importDefault(require("bs58"));
class LeaderTpuCache {
    constructor(connection, startSlot) {
        this.connection = connection;
        this.first_slot = startSlot;
    }
    static load(connection, startSlot) {
        return new Promise((resolve) => {
            const leaderTpuCache = new LeaderTpuCache(connection, startSlot);
            leaderTpuCache.connection.getEpochInfo().then(epochInfo => {
                leaderTpuCache.slots_in_epoch = epochInfo.slotsInEpoch;
                leaderTpuCache.fetchSlotLeaders(leaderTpuCache.first_slot, leaderTpuCache.slots_in_epoch).then((leaders) => {
                    leaderTpuCache.leaders = leaders;
                    leaderTpuCache.fetchClusterTpuSockets().then(leaderTpuMap => {
                        leaderTpuCache.leaderTpuMap = leaderTpuMap;
                        resolve(leaderTpuCache);
                    });
                });
            });
        });
    }
    fetchClusterTpuSockets() {
        return new Promise((resolve, reject) => {
            const map = new Map();
            this.connection.getClusterNodes().then(contactInfo => {
                contactInfo.forEach(contactInfo => {
                    map.set(contactInfo.pubkey, contactInfo.tpu);
                });
                resolve(map);
            }).catch(error => {
                reject(error);
            });
        });
    }
    fetchSlotLeaders(start_slot, slots_in_epoch) {
        const fanout = Math.min((2 * exports.MAX_FANOUT_SLOTS), slots_in_epoch);
        return this.connection.getSlotLeaders(start_slot, fanout);
    }
    lastSlot() {
        return this.first_slot + this.leaders.length - 1;
    }
    getSlotLeader(slot) {
        if (slot >= this.first_slot) {
            const index = slot - this.first_slot;
            return this.leaders[index];
        }
        else {
            return null;
        }
    }
    getLeaderSockets(fanout_slots) {
        return new Promise((resolve) => {
            const leaderSet = new Set();
            const leaderSockets = new Array();
            let checkedSlots = 0;
            this.leaders.forEach((leader) => {
                const tpu_socket = this.leaderTpuMap.get(leader.toBase58());
                if (tpu_socket !== undefined && tpu_socket !== null) {
                    if (!leaderSet.has(leader.toBase58())) {
                        leaderSet.add(leader.toBase58());
                        leaderSockets.push(tpu_socket);
                    }
                }
                else {
                    console.log('TPU not available for leader: ', leader.toBase58());
                }
                checkedSlots++;
                if (checkedSlots === fanout_slots) {
                    resolve(leaderSockets);
                }
            });
        });
    }
}
exports.LeaderTpuCache = LeaderTpuCache;
exports.MAX_SLOT_SKIP_DISTANCE = 48;
exports.DEFAULT_FANOUT_SLOTS = 12;
exports.MAX_FANOUT_SLOTS = 100;
class RecentLeaderSlots {
    constructor(current_slot) {
        this.recent_slots = new denque_1.default();
        this.recent_slots.push(current_slot);
    }
    recordSlot(current_slot) {
        this.recent_slots.push(current_slot);
        while (this.recent_slots.length > 12) {
            this.recent_slots.pop();
        }
    }
    estimatedCurrentSlot() {
        if (this.recent_slots.isEmpty()) {
            throw new Error('recent slots is empty');
        }
        const sortedRecentSlots = this.recent_slots.toArray().sort((a, b) => a - b);
        const max_index = sortedRecentSlots.length - 1;
        const median_index = max_index / 2;
        const median_recent_slot = sortedRecentSlots[median_index];
        const expected_current_slot = median_recent_slot + (max_index - median_index);
        const max_reasonable_current_slot = expected_current_slot + exports.MAX_SLOT_SKIP_DISTANCE;
        return sortedRecentSlots.reverse().find(slot => slot <= max_reasonable_current_slot);
    }
}
exports.RecentLeaderSlots = RecentLeaderSlots;
class TpuClient {
    constructor(connection, config = { fanoutSlots: exports.DEFAULT_FANOUT_SLOTS }) {
        this.connection = connection;
        this.sendSocket = dgram_1.default.createSocket('udp4');
        this.fanoutSlots = Math.max(Math.min(config.fanoutSlots, exports.MAX_FANOUT_SLOTS), 1);
        console.log('started tpu client');
    }
    static load(connection, websocketUrl = '', config = { fanoutSlots: exports.DEFAULT_FANOUT_SLOTS }) {
        return new Promise((resolve) => {
            const tpuClient = new TpuClient(connection, config);
            LeaderTpuService.load(tpuClient.connection, websocketUrl).then((leaderTpuService) => {
                tpuClient.leaderTpuService = leaderTpuService;
                resolve(tpuClient);
            });
        });
    }
    async sendTransaction(transaction, signers) {
        if (transaction.nonceInfo) {
            transaction.sign(...signers);
        }
        else {
            transaction.recentBlockhash = (await this.connection.getRecentBlockhash()).blockhash;
            transaction.sign(...signers);
        }
        const rawTransaction = transaction.serialize();
        return this.sendRawTransaction(rawTransaction);
    }
    async sendRawTransaction(rawTransaction) {
        return new Promise((resolve, reject) => {
            this.leaderTpuService.leaderTpuSockets(this.fanoutSlots).then((tpu_addresses) => {
                tpu_addresses.forEach(tpu_address => {
                    this.sendSocket.send(rawTransaction, parseInt(tpu_address.split(':')[1]), tpu_address.split(':')[0], (error) => {
                        if (!error) {
                            const message = web3_js_1.Transaction.from(rawTransaction);
                            resolve(bs58_1.default.encode(message.signature));
                        }
                        else {
                            console.error(error);
                            reject(error);
                        }
                    });
                });
            });
        });
    }
}
exports.TpuClient = TpuClient;
class LeaderTpuService {
    constructor(connection) {
        this.connection = connection;
    }
    static load(connection, websocket_url = '') {
        return new Promise((resolve) => {
            const leaderTpuService = new LeaderTpuService(connection);
            leaderTpuService.connection.getSlot('processed').then((start_slot) => {
                leaderTpuService.recentSlots = new RecentLeaderSlots(start_slot);
                LeaderTpuCache.load(connection, start_slot).then(leaderTpuCache => {
                    leaderTpuService.leaderTpuCache = leaderTpuCache;
                    if (websocket_url !== '') {
                        leaderTpuService.subscription = connection.onSlotUpdate((slotUpdate) => {
                            if (slotUpdate.type === 'completed') {
                                slotUpdate.slot++;
                            }
                            leaderTpuService.recentSlots.recordSlot(slotUpdate.slot);
                        });
                    }
                    else {
                        leaderTpuService.subscription = null;
                    }
                    leaderTpuService.run();
                    resolve(leaderTpuService);
                });
            });
        });
    }
    leaderTpuSockets(fanout_slots) {
        return this.leaderTpuCache.getLeaderSockets(fanout_slots);
    }
    async run() {
        const last_cluster_refresh = Date.now();
        let sleep_ms = 1000;
        setTimeout(async () => {
            sleep_ms = 1000;
            if (Date.now() - last_cluster_refresh > (1000 * 5 * 60)) {
                try {
                    this.leaderTpuCache.leaderTpuMap = await this.leaderTpuCache.fetchClusterTpuSockets();
                }
                catch (error) {
                    console.warn('Failed to fetch cluster tpu sockets', error);
                    sleep_ms = 1000;
                }
            }
            const estimatedCurrentSlot = this.recentSlots.estimatedCurrentSlot();
            if (estimatedCurrentSlot >= this.leaderTpuCache.last_epoch_info_slot - this.leaderTpuCache.slots_in_epoch) {
                try {
                    const epochInfo = await this.connection.getEpochInfo('recent');
                    this.leaderTpuCache.slots_in_epoch = epochInfo.slotsInEpoch;
                    this.leaderTpuCache.last_epoch_info_slot = estimatedCurrentSlot;
                }
                catch (error) {
                    console.warn('failed to get epoch info');
                }
            }
            if (estimatedCurrentSlot >= (this.leaderTpuCache.lastSlot() - exports.MAX_FANOUT_SLOTS)) {
                try {
                    const slot_leaders = await this.leaderTpuCache.fetchSlotLeaders(estimatedCurrentSlot, this.leaderTpuCache.slots_in_epoch);
                    this.leaderTpuCache.first_slot = estimatedCurrentSlot;
                    this.leaderTpuCache.leaders = slot_leaders;
                }
                catch (error) {
                    console.warn(`Failed to fetch slot leaders (current estimated slot: ${estimatedCurrentSlot})`, error);
                    sleep_ms = 1000;
                }
            }
            this.run();
        }, sleep_ms);
    }
}
exports.LeaderTpuService = LeaderTpuService;
class TpuConnection extends web3_js_1.Connection {
    constructor(endpoint, commitmentOrConfig) {
        super(endpoint, commitmentOrConfig);
    }
    sendTransaction(transaction, signers) {
        return this.tpuClient.sendTransaction(transaction, signers);
    }
    sendRawTransaction(rawTransaction) {
        return this.tpuClient.sendRawTransaction(rawTransaction);
    }
    async sendAndConfirmTransaction(connection, transaction, signers, options) {
        const signature = await this.sendTransaction(transaction, signers);
        const status = (await connection.confirmTransaction(signature, options.commitment)).value;
        if (status.err) {
            throw new Error(`Transaction ${signature} failed (${JSON.stringify(status)})`);
        }
        return signature;
    }
    async sendAndConfirmRawTransaction(connection, rawTransaction, options) {
        const signature = await this.sendRawTransaction(rawTransaction);
        const status = (await connection.confirmTransaction(signature, options.commitment)).value;
        if (status.err) {
            throw new Error(`Transaction ${signature} failed (${JSON.stringify(status)})`);
        }
        return signature;
    }
    static load(endpoint, commitmentOrConfig) {
        return new Promise((resolve) => {
            const tpuConnection = new TpuConnection(endpoint, commitmentOrConfig);
            TpuClient.load(tpuConnection).then(tpuClient => {
                tpuConnection.tpuClient = tpuClient;
                resolve(tpuConnection);
            });
        });
    }
}
exports.TpuConnection = TpuConnection;
//# sourceMappingURL=tpuClient.js.map