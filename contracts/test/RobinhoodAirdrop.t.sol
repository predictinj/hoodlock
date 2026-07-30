// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../RobinhoodAirdrop.sol";
import "./mocks/Tokens.sol";

interface IAirdropLike {
    function claim(uint256 id, uint256 index, address account, uint256 amount, bytes32[] calldata proof) external;
}

/// Re-enters claim() from inside transfer(), swallowing the revert so the outer
/// transfer still succeeds. Proves the guard prevents a double claim.
contract ReentrantAirdropToken is StandardToken {
    IAirdropLike public target;
    uint256 public id;
    uint256 public index;
    address public account;
    uint256 public amount;
    bytes32[] public proof;
    bool public armed;

    constructor(uint256 supply) StandardToken("EVIL", "EVIL", supply) {}

    function arm(address _t, uint256 _id, uint256 _index, address _account, uint256 _amount, bytes32[] memory _proof)
        external
    {
        target = IAirdropLike(_t);
        id = _id; index = _index; account = _account; amount = _amount;
        proof = _proof;
        armed = true;
    }

    function _transfer(address from, address to, uint256 value) internal override returns (bool) {
        bool ok = super._transfer(from, to, value);
        if (armed) {
            armed = false; // one shot, so a blocked re-entry cannot recurse forever
            try target.claim(id, index, account, amount, proof) {} catch {}
        }
        return ok;
    }
}

contract RobinhoodAirdropTest is Test {
    RobinhoodAirdrop drop;
    StandardToken token;

    address creator = address(0xC0FFEE);
    address collector = address(0xFEE5);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);
    address dave = address(0xDA7E);

    uint256 constant UNIT = 1e18;

    function setUp() public {
        drop = new RobinhoodAirdrop(0, 0, collector, address(0));
        token = new StandardToken("Test", "TST", 1_000_000 * UNIT);
        token.transfer(creator, 500_000 * UNIT);
        vm.deal(creator, 100 ether);
    }

    // ───────────────────────── Merkle helpers ─────────────────────────
    // The convention here is the one shared/merkle.mjs must reproduce: leaves
    // are double-hashed, pairs are sorted before hashing, and an odd node is
    // promoted unchanged to the next level.

    function _leaf(uint256 index, address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function _root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            uint256 n = (level.length + 1) / 2;
            bytes32[] memory next = new bytes32[](n);
            for (uint256 i = 0; i < n; i++) {
                uint256 l = 2 * i;
                next[i] = (l + 1 < level.length) ? _pair(level[l], level[l + 1]) : level[l];
            }
            level = next;
        }
        return level[0];
    }

    function _proofFor(bytes32[] memory leaves, uint256 idx) internal pure returns (bytes32[] memory) {
        bytes32[] memory out = new bytes32[](32);
        uint256 count;
        bytes32[] memory level = leaves;
        uint256 pos = idx;
        while (level.length > 1) {
            uint256 sib = pos ^ 1;
            if (sib < level.length) out[count++] = level[sib];
            uint256 n = (level.length + 1) / 2;
            bytes32[] memory next = new bytes32[](n);
            for (uint256 i = 0; i < n; i++) {
                uint256 l = 2 * i;
                next[i] = (l + 1 < level.length) ? _pair(level[l], level[l + 1]) : level[l];
            }
            level = next;
            pos = pos / 2;
        }
        bytes32[] memory trimmed = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) trimmed[i] = out[i];
        return trimmed;
    }

    /// Four recipients of 100 tokens each.
    function _standardTree() internal view returns (bytes32[] memory leaves, address[4] memory who) {
        who = [alice, bob, carol, dave];
        leaves = new bytes32[](4);
        for (uint256 i = 0; i < 4; i++) leaves[i] = _leaf(i, who[i], 100 * UNIT);
    }

    function _create(bytes32 root, uint256 total, uint32 maxClaims, uint64 endTime) internal returns (uint256 id) {
        vm.startPrank(creator);
        token.approve(address(drop), total);
        id = drop.create{value: drop.quote(maxClaims)}(address(token), root, total, maxClaims, endTime, "");
        vm.stopPrank();
    }

    // ───────────────────────────── claims ─────────────────────────────

    function test_ClaimSucceedsOnceAndOnlyOnce() public {
        (bytes32[] memory leaves, ) = _standardTree();
        uint256 id = _create(_root(leaves), 400 * UNIT, 4, 0);

        bytes32[] memory p = _proofFor(leaves, 0);
        drop.claim(id, 0, alice, 100 * UNIT, p);
        assertEq(token.balanceOf(alice), 100 * UNIT);
        assertTrue(drop.isClaimed(id, 0));

        vm.expectRevert("already claimed");
        drop.claim(id, 0, alice, 100 * UNIT, p);
    }

    function test_AnyoneMaySubmitButTokensGoToTheLeafOwner() public {
        (bytes32[] memory leaves, ) = _standardTree();
        uint256 id = _create(_root(leaves), 400 * UNIT, 4, 0);

        vm.prank(bob); // bob pays the gas for alice's leaf
        drop.claim(id, 0, alice, 100 * UNIT, _proofFor(leaves, 0));
        assertEq(token.balanceOf(alice), 100 * UNIT);
        assertEq(token.balanceOf(bob), 0);
    }

    function test_ForgedProofReverts() public {
        (bytes32[] memory leaves, ) = _standardTree();
        uint256 id = _create(_root(leaves), 400 * UNIT, 4, 0);

        // Right proof, wrong claimant.
        vm.expectRevert("bad proof");
        drop.claim(id, 0, address(0xBAD), 100 * UNIT, _proofFor(leaves, 0));

        // Right claimant, inflated amount.
        vm.expectRevert("bad proof");
        drop.claim(id, 0, alice, 200 * UNIT, _proofFor(leaves, 0));

        // Someone not in the tree at all.
        bytes32[] memory empty = new bytes32[](0);
        vm.expectRevert("bad proof");
        drop.claim(id, 9, address(0xBAD), 1, empty);
    }

    /// K2: an internal node presented as a leaf must not verify. Double hashing
    /// makes leaf preimages 32 bytes and node preimages 64, so they cannot be
    /// confused.
    function test_InternalNodeCannotBeClaimedAsALeaf() public {
        (bytes32[] memory leaves, ) = _standardTree();
        uint256 id = _create(_root(leaves), 400 * UNIT, 4, 0);

        bytes32 node = _pair(leaves[0], leaves[1]);
        bytes32[] memory p = new bytes32[](1);
        p[0] = _pair(leaves[2], leaves[3]);

        // There is no (index, account, amount) whose leaf hash equals `node`,
        // so no call can present it. Assert the shape holds rather than the
        // absence of a preimage.
        assertTrue(node != _leaf(0, alice, 100 * UNIT));
        vm.expectRevert("bad proof");
        drop.claim(id, 0, alice, 99 * UNIT, p);
    }

    function test_ClaimCeilingHolds() public {
        (bytes32[] memory leaves, address[4] memory who) = _standardTree();
        // Declared for two wallets, but the tree holds four.
        uint256 id = _create(_root(leaves), 400 * UNIT, 2, 0);

        drop.claim(id, 0, who[0], 100 * UNIT, _proofFor(leaves, 0));
        drop.claim(id, 1, who[1], 100 * UNIT, _proofFor(leaves, 1));

        vm.expectRevert("claim ceiling reached");
        drop.claim(id, 2, who[2], 100 * UNIT, _proofFor(leaves, 2));
    }

    /// The bitmap uses one word per 256 indexes, so an index past the first
    /// word exercises the division and the mask together.
    function test_HighIndexClaims() public {
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = _leaf(300, alice, 100 * UNIT);
        leaves[1] = _leaf(517, bob, 100 * UNIT);
        uint256 id = _create(_root(leaves), 200 * UNIT, 2, 0);

        drop.claim(id, 300, alice, 100 * UNIT, _proofFor(leaves, 0));
        drop.claim(id, 517, bob, 100 * UNIT, _proofFor(leaves, 1));
        assertTrue(drop.isClaimed(id, 300));
        assertTrue(drop.isClaimed(id, 517));
        assertFalse(drop.isClaimed(id, 44)); // 300 % 256 == 44, must not alias
    }

    // ─────────────────────── K1 and K3, isolation ───────────────────────

    /// The heart of the design. Airdrop A's tree promises far more than A's
    /// deposit. A must not be able to reach airdrop B's tokens, even though
    /// both hold the same token in the same contract.
    function test_OverPromisingTreeCannotDrainAnotherAirdrop() public {
        // A: deposits 100, but its tree promises 100 to each of two wallets.
        bytes32[] memory greedy = new bytes32[](2);
        greedy[0] = _leaf(0, alice, 100 * UNIT);
        greedy[1] = _leaf(1, bob, 100 * UNIT);
        uint256 a = _create(_root(greedy), 100 * UNIT, 2, 0);

        // B: an honest, fully funded airdrop of the same token.
        bytes32[] memory honest = new bytes32[](1);
        honest[0] = _leaf(0, carol, 500 * UNIT);
        uint256 b = _create(_root(honest), 500 * UNIT, 1, 0);

        uint256 held = token.balanceOf(address(drop));
        assertEq(held, 600 * UNIT);

        // The first claim drains A exactly.
        drop.claim(a, 0, alice, 100 * UNIT, _proofFor(greedy, 0));
        assertEq(token.balanceOf(alice), 100 * UNIT);

        // The second is promised by A's tree but not funded by A's deposit.
        vm.expectRevert("airdrop exhausted");
        drop.claim(a, 1, bob, 100 * UNIT, _proofFor(greedy, 1));

        // B is untouched and fully claimable.
        drop.claim(b, 0, carol, 500 * UNIT, _proofFor(honest, 0));
        assertEq(token.balanceOf(carol), 500 * UNIT);
        assertEq(token.balanceOf(address(drop)), 0);
    }

    /// K3: the same index in two airdrops must be independently claimable.
    function test_ClaimedBitmapIsPerAirdrop() public {
        bytes32[] memory one = new bytes32[](1);
        one[0] = _leaf(0, alice, 10 * UNIT);
        bytes32[] memory two = new bytes32[](1);
        two[0] = _leaf(0, bob, 20 * UNIT);

        uint256 a = _create(_root(one), 10 * UNIT, 1, 0);
        uint256 b = _create(_root(two), 20 * UNIT, 1, 0);

        bytes32[] memory empty = new bytes32[](0);
        drop.claim(a, 0, alice, 10 * UNIT, empty);
        assertTrue(drop.isClaimed(a, 0));
        assertFalse(drop.isClaimed(b, 0));

        drop.claim(b, 0, bob, 20 * UNIT, empty);
        assertEq(token.balanceOf(bob), 20 * UNIT);
    }

    // ───────────────────────────── sweep ─────────────────────────────

    function test_SweepOnlyAfterDeadlineAndOnlyOnce() public {
        (bytes32[] memory leaves, ) = _standardTree();
        uint64 end = uint64(block.timestamp + 8 days);
        uint256 id = _create(_root(leaves), 400 * UNIT, 4, end);

        drop.claim(id, 0, alice, 100 * UNIT, _proofFor(leaves, 0));

        vm.prank(creator);
        vm.expectRevert("not closed yet");
        drop.sweep(id);

        vm.warp(end);

        // Claims are closed the moment sweeping opens: the windows are disjoint.
        vm.expectRevert("airdrop closed");
        drop.claim(id, 1, bob, 100 * UNIT, _proofFor(leaves, 1));

        uint256 before = token.balanceOf(creator);
        vm.prank(creator);
        drop.sweep(id);
        assertEq(token.balanceOf(creator) - before, 300 * UNIT);

        vm.prank(creator);
        vm.expectRevert("already swept");
        drop.sweep(id);
    }

    function test_OnlyCreatorMaySweep() public {
        (bytes32[] memory leaves, ) = _standardTree();
        uint64 end = uint64(block.timestamp + 8 days);
        uint256 id = _create(_root(leaves), 400 * UNIT, 4, end);
        vm.warp(end);

        vm.prank(bob);
        vm.expectRevert("not creator");
        drop.sweep(id);
    }

    function test_NoDeadlineMeansNeverSweepable() public {
        (bytes32[] memory leaves, ) = _standardTree();
        uint256 id = _create(_root(leaves), 400 * UNIT, 4, 0);

        vm.warp(block.timestamp + 3650 days);
        vm.prank(creator);
        vm.expectRevert("no deadline set");
        drop.sweep(id);

        // And claiming still works a decade later, which is the promise.
        drop.claim(id, 0, alice, 100 * UNIT, _proofFor(leaves, 0));
        assertEq(token.balanceOf(alice), 100 * UNIT);
    }

    function test_ShortWindowRejected() public {
        (bytes32[] memory leaves, ) = _standardTree();
        vm.startPrank(creator);
        token.approve(address(drop), 400 * UNIT);
        vm.expectRevert("window too short");
        drop.create(address(token), _root(leaves), 400 * UNIT, 4, uint64(block.timestamp + 1 hours), "");
        vm.stopPrank();
    }

    // ────────────────────────── token behaviour ──────────────────────────

    function test_FeeOnTransferTokenRejectedAtCreate() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(1_000 * UNIT);
        fot.transfer(creator, 500 * UNIT);
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = _leaf(0, alice, 100 * UNIT);

        vm.startPrank(creator);
        fot.approve(address(drop), 100 * UNIT);
        vm.expectRevert("fee-on-transfer token");
        drop.create(address(fot), _root(leaves), 100 * UNIT, 1, 0, "");
        vm.stopPrank();
    }

    function test_NoReturnTokenWorks() public {
        NoReturnToken nrt = new NoReturnToken(1_000 * UNIT);
        nrt.transfer(creator, 500 * UNIT);
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = _leaf(0, alice, 100 * UNIT);
        bytes32[] memory empty = new bytes32[](0);

        vm.startPrank(creator);
        nrt.approve(address(drop), 100 * UNIT);
        uint256 id = drop.create(address(nrt), _root(leaves), 100 * UNIT, 1, 0, "");
        vm.stopPrank();

        drop.claim(id, 0, alice, 100 * UNIT, empty);
        assertEq(nrt.balanceOf(alice), 100 * UNIT);
    }

    function test_FalseReturnTokenReverts() public {
        FalseReturnToken frt = new FalseReturnToken(1_000 * UNIT);
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = _leaf(0, alice, 100 * UNIT);

        vm.expectRevert("transferFrom failed");
        drop.create(address(frt), _root(leaves), 100 * UNIT, 1, 0, "");
    }

    function test_CodelessTokenRejected() public {
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = _leaf(0, alice, 1);
        vm.prank(creator);
        vm.expectRevert("token has no code");
        drop.create(address(0xDEAD), _root(leaves), 1, 1, 0, "");
    }

    /// K5: a token that re-enters claim() during its own transfer must not be
    /// able to claim the same leaf twice.
    function test_ReentrantTokenCannotDoubleClaim() public {
        ReentrantAirdropToken evil = new ReentrantAirdropToken(1_000 * UNIT);
        evil.transfer(creator, 500 * UNIT);
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = _leaf(0, alice, 100 * UNIT);
        bytes32[] memory empty = new bytes32[](0);

        vm.startPrank(creator);
        evil.approve(address(drop), 100 * UNIT);
        uint256 id = drop.create(address(evil), _root(leaves), 100 * UNIT, 1, 0, "");
        vm.stopPrank();

        evil.arm(address(drop), id, 0, alice, 100 * UNIT, empty);
        drop.claim(id, 0, alice, 100 * UNIT, empty);

        assertEq(evil.balanceOf(alice), 100 * UNIT); // paid once, not twice
        assertEq(evil.balanceOf(address(drop)), 0);
    }

    // ────────────────────────────── fees ──────────────────────────────

    function test_QuoteScalesAndIsCapped() public {
        vm.prank(address(this));
        drop.setFee(0.001 ether, 0.0001 ether);
        assertEq(drop.quote(0), 0.001 ether);
        assertEq(drop.quote(100), 0.001 ether + 0.01 ether);
        // At the largest permitted airdrop the cap binds.
        assertEq(drop.quote(drop.MAX_RECIPIENTS()), drop.MAX_FEE());
    }

    /// Invariant 9, the whole of it: for anything setFee accepts, quote must
    /// never exceed the cap and must never revert, at any recipient count.
    /// Deliberately fuzzed over the full uint256 range rather than a bounded
    /// one, so the parameters that would overflow the multiplication are
    /// exercised too.
    function testFuzz_QuoteNeverExceedsCapAndNeverReverts(uint256 base, uint256 perWallet, uint32 n) public {
        try drop.setFee(base, perWallet) {
            assertLe(drop.quote(n), drop.MAX_FEE());
            assertLe(drop.quote(drop.MAX_RECIPIENTS()), drop.MAX_FEE());
        } catch {
            // Rejected, which is the other half of the guarantee: a parameter
            // that could overflow the quote is never allowed to be stored.
            assertTrue(base > drop.MAX_FEE() || perWallet > drop.MAX_FEE());
        }
    }

    /// A perWallet large enough to overflow the multiplication would make
    /// quote() revert, and a reverting quote takes create() down with it. The
    /// parameter bound exists to stop exactly that.
    function test_SetFeeRejectsParametersThatCouldOverflowTheQuote() public {
        vm.expectRevert("fee param over cap");
        drop.setFee(0, 1 ether); // 1 ether > MAX_FEE

        vm.expectRevert("fee param over cap");
        drop.setFee(0, type(uint256).max);

        // The largest values it does accept still quote without reverting.
        drop.setFee(drop.MAX_FEE(), drop.MAX_FEE());
        assertEq(drop.quote(drop.MAX_RECIPIENTS()), drop.MAX_FEE());
        assertEq(drop.quote(0), drop.MAX_FEE());
    }

    function test_WrongFeeReverts() public {
        drop.setFee(0.01 ether, 0);
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = _leaf(0, alice, 1 * UNIT);

        vm.startPrank(creator);
        token.approve(address(drop), 1 * UNIT);
        vm.expectRevert("bad fee");
        drop.create{value: 0.009 ether}(address(token), _root(leaves), 1 * UNIT, 1, 0, "");
        vm.stopPrank();
    }

    /// Invariant 10, and H2: a reverting collector can only block its own
    /// withdrawal, never a create.
    function test_EthBalanceAlwaysEqualsAccruedFees() public {
        drop.setFee(0.01 ether, 0);
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = _leaf(0, alice, 1 * UNIT);

        vm.startPrank(creator);
        token.approve(address(drop), 2 * UNIT);
        drop.create{value: 0.01 ether}(address(token), _root(leaves), 1 * UNIT, 1, 0, "");
        drop.create{value: 0.01 ether}(address(token), _root(leaves), 1 * UNIT, 1, 0, "");
        vm.stopPrank();

        assertEq(address(drop).balance, drop.accruedFees());
        assertEq(drop.accruedFees(), 0.02 ether);

        vm.prank(collector);
        drop.withdrawFees();
        assertEq(address(drop).balance, 0);
        assertEq(drop.accruedFees(), 0);
    }

    function test_HostileCollectorCannotBrickCreate() public {
        RevertingCollector hostile = new RevertingCollector();
        drop.setFeeCollector(address(hostile));
        drop.setFee(0.01 ether, 0);

        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = _leaf(0, alice, 1 * UNIT);
        vm.startPrank(creator);
        token.approve(address(drop), 1 * UNIT);
        drop.create{value: 0.01 ether}(address(token), _root(leaves), 1 * UNIT, 1, 0, ""); // succeeds
        vm.stopPrank();

        vm.prank(address(hostile));
        vm.expectRevert("eth send failed");
        drop.withdrawFees();
    }

    function test_StrayEthReverts() public {
        (bool ok, ) = address(drop).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ────────────────────────────── admin ──────────────────────────────

    /// Invariant 8: no admin call can reach a funded airdrop.
    function test_AdminCannotReachAFundedAirdrop() public {
        (bytes32[] memory leaves, ) = _standardTree();
        uint256 id = _create(_root(leaves), 400 * UNIT, 4, 0);

        RobinhoodAirdrop.Airdrop memory before = drop.getAirdrop(id);
        uint256 heldBefore = token.balanceOf(address(drop));

        drop.setFee(0.001 ether, 0.0001 ether);
        drop.setFeeCollector(address(0xBEEF));
        drop.transferAdmin(bob);
        vm.prank(bob);
        drop.acceptAdmin();
        vm.startPrank(bob);
        drop.setFee(0, 0);
        drop.setFeeCollector(bob);
        vm.stopPrank();

        RobinhoodAirdrop.Airdrop memory afterAll = drop.getAirdrop(id);
        assertEq(afterAll.remaining, before.remaining);
        assertEq(afterAll.merkleRoot, before.merkleRoot);
        assertEq(afterAll.endTime, before.endTime);
        assertEq(afterAll.total, before.total);
        assertEq(token.balanceOf(address(drop)), heldBefore);

        // And the recipients can still claim afterwards.
        drop.claim(id, 0, alice, 100 * UNIT, _proofFor(leaves, 0));
        assertEq(token.balanceOf(alice), 100 * UNIT);
    }

    /// The owner is named at construction, so there is never a window where the
    /// deploying key is admin.
    function test_AdminIsSetAtConstruction() public {
        address owner = address(0xF00DBABE);
        RobinhoodAirdrop d = new RobinhoodAirdrop(0, 0, collector, owner);
        assertEq(d.admin(), owner, "admin should be the named owner, not the deployer");
        vm.expectRevert("not admin");
        d.setFee(0, 0); // this test contract deployed it and still cannot touch it
    }

    function test_AdminTransferIsTwoStep() public {
        drop.transferAdmin(bob);
        assertEq(drop.admin(), address(this)); // not yet
        vm.prank(carol);
        vm.expectRevert("not pending admin");
        drop.acceptAdmin();
        vm.prank(bob);
        drop.acceptAdmin();
        assertEq(drop.admin(), bob);
    }

    function test_NonAdminCannotSetFee() public {
        vm.prank(bob);
        vm.expectRevert("not admin");
        drop.setFee(0, 0);
    }

    // ──────────────────────────── create guards ────────────────────────────

    function test_CreateGuards() public {
        bytes32[] memory leaves = new bytes32[](1);
        leaves[0] = _leaf(0, alice, 1 * UNIT);
        bytes32 root = _root(leaves);

        vm.startPrank(creator);
        token.approve(address(drop), 100 * UNIT);

        vm.expectRevert("zero root");
        drop.create(address(token), bytes32(0), 1 * UNIT, 1, 0, "");

        vm.expectRevert("zero total");
        drop.create(address(token), root, 0, 1, 0, "");

        vm.expectRevert("bad recipient count");
        drop.create(address(token), root, 1 * UNIT, 0, 0, "");

        vm.expectRevert("bad recipient count");
        drop.create(address(token), root, 1 * UNIT, 250_001, 0, "");

        string memory long = new string(257);
        vm.expectRevert("uri too long");
        drop.create(address(token), root, 1 * UNIT, 1, 0, long);

        vm.stopPrank();
    }

    /// The by-token and by-creator lookups live in the event log, not in
    /// on-chain arrays, so that nobody can bloat another token's index. All the
    /// contract itself counts is how many airdrops exist.
    function test_CreationIsCounted() public {
        (bytes32[] memory leaves, ) = _standardTree();
        _create(_root(leaves), 400 * UNIT, 4, 0);
        _create(_root(leaves), 100 * UNIT, 1, 0);
        assertEq(drop.totalAirdrops(), 2);
    }

    /// The event has to carry everything the removed getters would have
    /// answered, or the indexes become unreconstructible.
    function test_CreationEventCarriesTokenAndCreator() public {
        (bytes32[] memory leaves, ) = _standardTree();
        bytes32 root = _root(leaves);
        vm.startPrank(creator);
        token.approve(address(drop), 400 * UNIT);
        vm.expectEmit(true, true, true, true);
        emit RobinhoodAirdrop.AirdropCreated(0, address(token), creator, root, 400 * UNIT, 4, 0, "");
        drop.create(address(token), root, 400 * UNIT, 4, 0, "");
        vm.stopPrank();
    }
}
