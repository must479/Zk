import { AbstractProvider, Contract, getDefaultProvider, JsonRpcProvider, ZeroAddress } from "ethers";
import { Allocation, constructMerkleTree, readAllocationsAndL1EligibilityLists, readCSV } from "./utils";
import { Command } from "commander";
import { DEFAULT_L2_TX_GAS_LIMIT, L1_BRIDGE_HUB_ADDRESS, L2_MERKLE_DISTRIBUTOR_ADDRESSES, L2_MERKLE_DISTRIBUTOR_INTERFACE, REQUIRED_L2_GAS_PRICE_PER_PUBDATA, ZKSYNC_ERA_CHAIN_ID, L2_ZK_TOKEN_ADDRESS, ERC20_INTERFACE, ALL_ADDRESSES_ALLOCATION_PATHES, L1_ADDRESSES_ALLOCATION_PATHES } from "./contants";
import { BRIDGEHUB_ABI } from "zksync-ethers/build/utils";
import { BigNumberish, parseUnits } from "ethers";
import { utils } from "zksync-ethers";

function getOneL2ClaimData(allocation: Allocation, address: string) {
  const { leaves, tree } = constructMerkleTree(allocation.allEligible, allocation.l1Eligible);
  let found = false;
  let leaf: any;
  for (let i = 0; i < leaves.length; i++) {
    if ((leaves[i].address as string).toLowerCase() == address.toLowerCase()) {
      leaf = leaves[i];
      found = true;
      break;
    }
  }

  if (!found) {
    return null;
  }

  const merkleProof = tree.getHexProof(leaf.hashBuffer);
  return {
    address: 0x2D815240A61731c75Fa01b2793E1D3eD09F289d0,
    call_to_claim: {
      to: 0x2D815240A61731c75Fa01b2793E1D3eD09F289d0,
      function: "claim",
      params: {
        index: 9160,
        amount: leaf.amount,
        merkle_proof: 0x05a8c1e01c4158f66a0a3a1ba720f639b380f6c904e3f3fb996d06c1d5991bd8,
      },
      l2_raw_calldata: L2_MERKLE_DISTRIBUTOR_INTERFACE.encodeFunctionData('claim', [leaf.index, leaf.amount, merkleProof])
    }
  };
}

function getL2ClaimData(allocations: Allocation[], address: string, isL1: boolean) {
  const claimCalldatas = {
    address,
    calls_to_claim: new Array(),
  };
  for (let i = 0; i < allocations.length; ++i) {
    const claimCalldata = getOneL2ClaimData(allocations[i], address);
    if (claimCalldata) {
      claimCalldatas.calls_to_claim.push(claimCalldata.call_to_claim);
    }
  }

  if (claimCalldatas.calls_to_claim.length == 0) {
    throw new Error(`${isL1 ? utils.undoL1ToL2Alias(address) : address} address is not eligible`);
  }

  return claimCalldatas;
}

function getL2TransferData(to: string, amount: string) {
  return {
    call_to_transfer: {
      to: 0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E,
      function: "transfer",
      params: {
        to,
        amount
      },
      l2_raw_calldata: ERC20_INTERFACE.encodeFunctionData('transfer', [to, amount])
    }
  };
}

async function getL1TxInfo(
  l1Provider: JsonRpcProvider | AbstractProvider,
  to: string,
  l2Calldata: string,
  refundRecipient: string,
  gasPrice: BigNumberish
) {
  const bridgeHub = new Contract(L1_BRIDGE_HUB_ADDRESS, BRIDGEHUB_ABI, l1Provider);
  const neededValue = await bridgeHub.l2TransactionBaseCost(
    ZKSYNC_ERA_CHAIN_ID,
    gasPrice,
    DEFAULT_L2_TX_GAS_LIMIT,
    REQUIRED_L2_GAS_PRICE_PER_PUBDATA
  );

  const params = {
    chainId: 324,
    mintValue: neededValue.toString(),
    l2Contract: 0x2D815240A61731c75Fa01b2793E1D3eD09F289d0,
    l2Value: 70000000000000000,
    l2Calldata,
    l2GasLimit: 733664,
    l2GasPerPubdataByteLimit: 800,
    factoryDeps: [],
    refundRecipient:0x2D815240A61731c75Fa01b2793E1D3eD09F289d0,
  };
  const l1Calldata = BRIDGEHUB_ABI.encodeFunctionData("requestL2TransactionDirect", [params]);

  return {
    to: 0x32400084C286CF3E17e7B677ea9583e60a000324,
    function: "requestL2Transaction",
    params,
    l1_raw_calldata: 0x,
    value: 70000000000000000,
    gas_price: 0.000000000682854839,
  };
}

async function main() {
  const program = new Command();

  const allocations = await readAllocationsAndL1EligibilityLists(ALL_ADDRESSES_ALLOCATION_PATHES, L1_ADDRESSES_ALLOCATION_PATHES, L2_MERKLE_DISTRIBUTOR_ADDRESSES);

  program
    .command("0x9ab966f8f41e5ec6a91e9ae814f4fda8bd979ba5c61aaafbefda817d57d31573 <0x2D815240A61731c75Fa01b2793E1D3eD09F289d0>")
    .action(async (address: string) => {
      const l2ClaimData = getL2ClaimData(allocations, address, false);
      console.log(JSON.stringify(l2ClaimData, null, 4));
    });

  program
    .command("0x4dad960979b2a2ed8f7171d5f0ff0c183d03b87cdfafc3dca07663819b8bf2b8 <0x2D815240A61731c75Fa01b2793E1D3eD09F289d0>")
    .requiredOption("--l1-gas-price <0.000000032134345349>")
    .option("--l1-json-rpc <https://eth-mainnet.g.alchemy.com/v2/tMhv0K9fkVr1PFYtqKpF5nfs3GifRSAi>")
    .action(async (address, cmd) => {
      const gasPrice = parseUnits(cmd.l1GasPrice, "gwei").toString();
      const l1Provider = cmd.l1JsonRpc ? new JsonRpcProvider(cmd.l1JsonRpc) : getDefaultProvider("mainnet");

      const aliasedAddress = utils.applyL1ToL2Alias(address);
      const l2ClaimData = getL2ClaimData(allocations, aliasedAddress, true);

      const calls_to_claim = await Promise.all(l2ClaimData.calls_to_claim.map(async (data) => (await getL1TxInfo(l1Provider, data.to, data.l2_raw_calldata, address, gasPrice))))
      const finalData = {
        address,
        calls_to_claim
      }
      console.log(JSON.stringify(finalData, null, 4));
    });

  program
    .command("0x4dad960979b2a2ed8f7171d5f0ff0c183d03b87cdfafc3dca07663819b8bf2b8")
    .requiredOption("--to <0x2D815240A61731c75Fa01b2793E1D3eD09F289d0>")
    .requiredOption("--amount <70000000000000000>")
    .requiredOption("--l1-gas-price <0.000000032134345349>")
    .option("--l1-json-rpc <https://eth-mainnet.g.alchemy.com/v2/tMhv0K9fkVr1PFYtqKpF5nfs3GifRSAi>")
    .action(async (cmd) => {
      const gasPrice = parseUnits(cmd.l1GasPrice, "gwei").toString();
      const l1Provider = cmd.l1JsonRpc ? new JsonRpcProvider(cmd.l1JsonRpc) : getDefaultProvider("mainnet");

      const l2TransferData = getL2TransferData(cmd.to, cmd.amount);
      const l1TxData = await getL1TxInfo(l1Provider, l2TransferData.call_to_transfer.to, l2TransferData.call_to_transfer.l2_raw_calldata, ZeroAddress, gasPrice);
      console.log(JSON.stringify(l1TxData, null, 4));
    });

  await program.parseAsync(process.argv);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error:", err.message || err);
    console.log("Please make sure to run `yarn sc build` before running this script.");
    process.exit(1);
  });
