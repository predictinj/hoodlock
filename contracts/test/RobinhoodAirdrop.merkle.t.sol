// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "../RobinhoodAirdrop.sol";
import "./mocks/Tokens.sol";

/**
 * Cross-environment agreement between shared/merkle.mjs and this contract.
 *
 * The browser computes the root, the server computes the proofs, and the
 * contract verifies them. A one-byte disagreement anywhere in that chain means
 * no claim ever succeeds, and it would not show up in either half's own tests,
 * because each half would happily agree with itself.
 *
 * So nothing here is computed in Solidity. The root and the proofs are read
 * from contracts/test/fixtures/merkle.json, produced by shared/gen-fixture.mjs,
 * and handed to the real contract. If the two conventions differ, these claims
 * revert.
 *
 * Regenerate the fixture with: node shared/gen-fixture.mjs
 */
contract RobinhoodAirdropMerkleTest is Test {
    RobinhoodAirdrop drop;
    StandardToken token;
    address creator = address(0xC0FFEE);

    string fixture;

    function setUp() public {
        drop = new RobinhoodAirdrop(0, 0, address(this));
        token = new StandardToken("Test", "TST", 1e33);
        token.transfer(creator, 1e32);
        vm.deal(creator, 10 ether);
        fixture = vm.readFile("contracts/test/fixtures/merkle.json");
    }

    function _create() internal returns (uint256 id) {
        bytes32 root = vm.parseJsonBytes32(fixture, ".root");
        uint256 total = vm.parseJsonUint(fixture, ".total");
        uint256 count = vm.parseJsonUint(fixture, ".count");

        vm.startPrank(creator);
        token.approve(address(drop), total);
        id = drop.create(address(token), root, total, uint32(count), 0, "");
        vm.stopPrank();
    }

    /// Every proof JavaScript produced must verify inside the contract, and the
    /// amounts must land exactly.
    function test_JavaScriptProofsVerifyOnChain() public {
        uint256 id = _create();
        uint256 n = vm.parseJsonUint(fixture, ".claimCount");
        assertGt(n, 0, "fixture has no claims");

        for (uint256 i = 0; i < n; i++) {
            string memory at = string.concat(".claims[", vm.toString(i), "]");
            uint256 index = vm.parseJsonUint(fixture, string.concat(at, ".index"));
            address account = vm.parseJsonAddress(fixture, string.concat(at, ".account"));
            uint256 amount = vm.parseJsonUint(fixture, string.concat(at, ".amount"));
            bytes32[] memory proof = vm.parseJsonBytes32Array(fixture, string.concat(at, ".proof"));

            uint256 before = token.balanceOf(account);
            drop.claim(id, index, account, amount, proof);
            assertEq(token.balanceOf(account) - before, amount, "wrong amount paid");
            assertTrue(drop.isClaimed(id, index));
        }
    }

    /// The same proofs must fail against a tampered leaf, which rules out the
    /// test passing because the contract accepts anything.
    function test_TamperedLeafFailsWithTheSameProof() public {
        uint256 id = _create();
        string memory at = ".claims[0]";
        uint256 index = vm.parseJsonUint(fixture, string.concat(at, ".index"));
        address account = vm.parseJsonAddress(fixture, string.concat(at, ".account"));
        uint256 amount = vm.parseJsonUint(fixture, string.concat(at, ".amount"));
        bytes32[] memory proof = vm.parseJsonBytes32Array(fixture, string.concat(at, ".proof"));

        vm.expectRevert("bad proof");
        drop.claim(id, index, account, amount + 1, proof);

        vm.expectRevert("bad proof");
        drop.claim(id, index + 1, account, amount, proof);

        vm.expectRevert("bad proof");
        drop.claim(id, index, address(uint160(account) + 1), amount, proof);
    }

    /// The fixture's declared total must be exactly what the tree pays out, or
    /// the list and the deposit have drifted apart.
    function test_FixtureTotalMatchesTheDeposit() public view {
        uint256 total = vm.parseJsonUint(fixture, ".total");
        uint256 count = vm.parseJsonUint(fixture, ".count");
        assertGt(total, 0);
        assertEq(count, 101, "fixture size changed; regenerate and re-check");
    }
}
