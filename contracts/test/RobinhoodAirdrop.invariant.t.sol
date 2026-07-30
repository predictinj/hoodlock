// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../RobinhoodAirdrop.sol";
import "./mocks/Tokens.sol";

/**
 * Random-walk handler: actors create airdrops, claim, sweep, warp and pull fees,
 * while ghost variables track ground truth.
 *
 * Every tree here holds a single leaf, so the root is the leaf and the proof is
 * empty. That keeps proof construction out of the fuzzer's way while still
 * exercising the part that matters: the leaf's amount is fuzzed independently of
 * the deposit, so the walk constantly creates airdrops whose tree promises more
 * than was funded. That is precisely the K1 condition the isolation invariant
 * has to survive.
 */
contract Handler is Test {
    RobinhoodAirdrop public d;
    StandardToken[] public tokens;
    address[] public actors;

    // Coverage counters. An invariant that passes because nothing happened
    // proves nothing, and try/catch hides that from the revert column.
    uint256 public nCreated;
    uint256 public nClaimed;
    uint256 public nSwept;
    uint256 public nExhausted; // claims rejected because the tree over-promised (K1)

    // ghost accounting, per token
    mapping(address => uint256) public ghostIn;
    mapping(address => uint256) public ghostOut;

    // ghost accounting, per airdrop
    mapping(uint256 => uint256) public ghostClaimed;
    mapping(uint256 => uint256) public ghostSwept;

    // what each airdrop was created with, to prove nothing mutates it
    struct Snap { address creator; address token; bytes32 root; uint128 total; uint32 maxClaims; uint64 endTime; bool seen; }
    mapping(uint256 => Snap) public snaps;

    // the single leaf each airdrop was built around
    struct Leaf { address account; uint256 amount; }
    mapping(uint256 => Leaf) public leaves;

    receive() external payable {} // handler acts as feeCollector

    constructor(RobinhoodAirdrop _d) {
        d = _d;
        for (uint256 i = 0; i < 3; i++) tokens.push(new StandardToken("T", "T", 1e33));
        for (uint256 i = 0; i < 4; i++) {
            address a = makeAddr(string(abi.encodePacked("actor", i)));
            actors.push(a);
            vm.deal(a, 1_000 ether);
            for (uint256 j = 0; j < tokens.length; j++) {
                tokens[j].transfer(a, 1e30);
                vm.prank(a);
                tokens[j].approve(address(d), type(uint256).max);
            }
        }
    }

    function _leafHash(uint256 index, address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
    }

    function createAirdrop(
        uint256 actorSeed, uint256 tokenSeed, uint256 accSeed,
        uint96 deposit, uint96 promise_, uint32 endDelta, bool noDeadline, bool overPromise
    ) external {
        address actor = actors[actorSeed % actors.length];
        StandardToken t = tokens[tokenSeed % tokens.length];
        address acc = actors[accSeed % actors.length];
        uint256 dep = uint256(deposit) % 1e24 + 1;
        // Half the walk funds its tree exactly, so the claim path is common;
        // the other half promises more than it deposited, which is the K1
        // condition the isolation invariant exists to survive.
        uint256 promised = overPromise ? dep + (uint256(promise_) % 1e24 + 1) : dep;
        uint64 end = noDeadline ? 0 : uint64(block.timestamp + 8 days + (endDelta % 300 days));

        bytes32 root = _leafHash(0, acc, promised);
        uint256 id = d.totalAirdrops();
        uint256 feeNow = d.quote(1);

        vm.prank(actor);
        try d.create{value: feeNow}(address(t), root, dep, 1, end, "") {
            ghostIn[address(t)] += dep; // StandardToken transfers exactly
            snaps[id] = Snap(actor, address(t), root, uint128(dep), 1, end, true);
            leaves[id] = Leaf(acc, promised);
            nCreated++;
        } catch {}
    }

    function claimOne(uint256 idSeed) external {
        uint256 total = d.totalAirdrops();
        if (total == 0) return;
        uint256 id = idSeed % total;
        Leaf memory l = leaves[id];
        if (l.account == address(0)) return;
        RobinhoodAirdrop.Airdrop memory a = d.getAirdrop(id);
        bytes32[] memory empty = new bytes32[](0);

        bool overPromised = l.amount > a.remaining;
        try d.claim(id, 0, l.account, l.amount, empty) {
            ghostOut[a.token] += l.amount;
            ghostClaimed[id] += l.amount;
            nClaimed++;
        } catch {
            if (overPromised && !d.isClaimed(id, 0)) nExhausted++;
        }
    }

    function sweepOne(uint256 idSeed) external {
        uint256 total = d.totalAirdrops();
        if (total == 0) return;
        uint256 id = idSeed % total;
        RobinhoodAirdrop.Airdrop memory a = d.getAirdrop(id);
        if (a.total == 0) return;
        uint256 expected = a.remaining;

        vm.prank(a.creator);
        try d.sweep(id) {
            ghostOut[a.token] += expected;
            ghostSwept[id] += expected;
            nSwept++;
        } catch {}
    }

    /**
     * Reaching a sweep by chance needs create, then enough warps to pass the
     * deadline, then a sweep on that same id, which the random walk almost
     * never produced: the coverage counter showed zero sweeps across 4,096
     * calls. This action walks to the deadline first, so the sweep path is
     * actually exercised rather than merely permitted.
     */
    function closeAndSweep(uint256 idSeed) external {
        uint256 total = d.totalAirdrops();
        if (total == 0) return;
        uint256 id = idSeed % total;
        RobinhoodAirdrop.Airdrop memory a = d.getAirdrop(id);
        if (a.total == 0 || a.endTime == 0) return;
        if (block.timestamp < a.endTime) vm.warp(uint256(a.endTime));
        uint256 expected = a.remaining;

        vm.prank(a.creator);
        try d.sweep(id) {
            ghostOut[a.token] += expected;
            ghostSwept[id] += expected;
            nSwept++;
        } catch {}
    }

    /// Deliberately short hops. Warping up to a year at a time closed every
    /// deadline-bearing airdrop moments after it was created, so the walk spent
    /// almost all of its calls in a state where nothing could be claimed.
    /// closeAndSweep is what reaches the deadline on purpose.
    function warp(uint32 delta) external {
        vm.warp(block.timestamp + (delta % 20 days) + 1 hours);
    }

    function withdrawFees() external {
        try d.withdrawFees() {} catch {} // handler IS the collector
    }

    function tokenCount() external view returns (uint256) { return tokens.length; }
    function tokenAt(uint256 i) external view returns (address) { return address(tokens[i]); }
}

contract RobinhoodAirdropInvariantTest is Test {
    RobinhoodAirdrop d;
    Handler h;

    function setUp() public {
        vm.warp(1_700_000_000);
        d = new RobinhoodAirdrop(0.005 ether, 0.0001 ether, address(this));
        h = new Handler(d);
        d.setFeeCollector(address(h)); // handler pulls fees during the walk
        /* The fuzzer draws senders from a pool and tops their balances up so
           they can pay for calls. Left alone it will eventually pick the
           contract under test, funding it directly and breaking
           invariant_ethEqualsAccruedFees for a reason that has nothing to do
           with the contract: there is no receive(), so no real caller could
           ever put ETH there. Seen on a fork run, and present in the vesting
           suite for the same reason. */
        excludeSender(address(d));

        targetContract(address(h));
        bytes4[] memory sels = new bytes4[](6);
        sels[0] = Handler.createAirdrop.selector;
        sels[1] = Handler.claimOne.selector;
        sels[2] = Handler.sweepOne.selector;
        sels[3] = Handler.closeAndSweep.selector;
        sels[4] = Handler.warp.selector;
        sels[5] = Handler.withdrawFees.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
    }

    /// Invariant 1: per airdrop, remaining is exactly what was deposited minus
    /// what left, and nothing ever leaves beyond the deposit.
    function invariant_conservationPerAirdrop() public view {
        for (uint256 id = 0; id < d.totalAirdrops(); id++) {
            RobinhoodAirdrop.Airdrop memory a = d.getAirdrop(id);
            uint256 out = h.ghostClaimed(id) + h.ghostSwept(id);
            assertLe(out, uint256(a.total), "more left than was deposited");
            assertEq(uint256(a.remaining), uint256(a.total) - out, "remaining drifted");
            assertLe(uint256(a.claims), uint256(a.maxClaims), "claim ceiling breached");
        }
    }

    /// Invariants 2 and 3: the contract holds at least what it still owes for
    /// every token. An airdrop whose tree over-promises can never consume
    /// another airdrop's deposit.
    function invariant_solvencyPerToken() public view {
        for (uint256 i = 0; i < h.tokenCount(); i++) {
            address t = h.tokenAt(i);
            uint256 owed;
            for (uint256 id = 0; id < d.totalAirdrops(); id++) {
                RobinhoodAirdrop.Airdrop memory a = d.getAirdrop(id);
                if (a.token == t) owed += uint256(a.remaining);
            }
            assertGe(IERC20(t).balanceOf(address(d)), owed, "insolvent for this token");
            assertEq(IERC20(t).balanceOf(address(d)), h.ghostIn(t) - h.ghostOut(t), "balance drift");
        }
    }

    /// Invariant 10: no stray ETH can enter and fees only leave via withdrawFees.
    function invariant_ethEqualsAccruedFees() public view {
        assertEq(address(d).balance, d.accruedFees());
    }

    /**
     * Proves the walk is not vacuous, deterministically.
     *
     * This started life as an afterInvariant() check and immediately earned its
     * keep: it showed the random walk was reaching zero sweeps across 4,096
     * calls, so that third of the invariant surface was passing without ever
     * being exercised. But afterInvariant runs per walk, and Foundry gives no
     * guarantee that any single walk calls every action, so as a gate it fails
     * for scheduling reasons rather than real ones.
     *
     * Scripting the sequence keeps the assurance and drops the flakiness: if
     * the handler's actions are wired correctly, then the fuzzer driving those
     * same actions is exercising the invariants for real.
     */
    function test_HandlerReachesEveryPath() public {
        // Exactly funded, no deadline: claimable.
        h.createAirdrop(0, 0, 1, 1000, 0, 0, true, false);
        h.claimOne(0);
        assertGt(h.nCreated(), 0, "create path dead");
        assertGt(h.nClaimed(), 0, "claim path dead");

        // Over-promised: the claim must be refused (K1).
        h.createAirdrop(1, 0, 2, 1000, 5000, 0, true, true);
        h.claimOne(1);
        assertGt(h.nExhausted(), 0, "over-promise path dead");

        // With a deadline, then closed and swept.
        h.createAirdrop(2, 1, 3, 1000, 0, 0, false, false);
        h.closeAndSweep(2);
        assertGt(h.nSwept(), 0, "sweep path dead");
    }

    /// Invariant 8: no sequence of operations mutates what an airdrop was
    /// created with.
    function invariant_airdropFieldsImmutable() public view {
        for (uint256 id = 0; id < d.totalAirdrops(); id++) {
            (address creator, address token, bytes32 root, uint128 total, uint32 maxClaims, uint64 endTime, bool seen) = h.snaps(id);
            if (!seen) continue;
            RobinhoodAirdrop.Airdrop memory a = d.getAirdrop(id);
            assertEq(a.creator, creator);
            assertEq(a.token, token);
            assertEq(a.merkleRoot, root);
            assertEq(uint256(a.total), uint256(total));
            assertEq(uint256(a.maxClaims), uint256(maxClaims));
            assertEq(uint256(a.endTime), uint256(endTime));
        }
    }
}
