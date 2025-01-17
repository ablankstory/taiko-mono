import { BigNumber, ethers, Signer } from "ethers";
import { ethers as hardhatEthers } from "hardhat";
import {
    AddressManager,
    Bridge,
    EtherVault,
    LibTrieProof,
    TestHeaderSync,
} from "../../typechain";
import { Message } from "./message";
import { Block, BlockHeader, getBlockHeader } from "./rpc";
import { getSignalProof, getSignalSlot } from "./signal";

async function deployBridge(
    signer: Signer,
    addressManager: AddressManager,
    destChain: number,
    srcChain: number
): Promise<{ bridge: Bridge; etherVault: EtherVault }> {
    const libTrieProof: LibTrieProof = await (
        await hardhatEthers.getContractFactory("LibTrieProof")
    )
        .connect(signer)
        .deploy();

    const libBridgeProcess = await (
        await hardhatEthers.getContractFactory("LibBridgeProcess", {
            libraries: {
                LibTrieProof: libTrieProof.address,
            },
        })
    )
        .connect(signer)
        .deploy();

    const libBridgeRetry = await (
        await hardhatEthers.getContractFactory("LibBridgeRetry")
    )
        .connect(signer)
        .deploy();

    const BridgeFactory = await hardhatEthers.getContractFactory("Bridge", {
        libraries: {
            LibBridgeProcess: libBridgeProcess.address,
            LibBridgeRetry: libBridgeRetry.address,
            LibTrieProof: libTrieProof.address,
        },
    });

    const bridge: Bridge = await BridgeFactory.connect(signer).deploy();

    await bridge.connect(signer).init(addressManager.address);

    const etherVault: EtherVault = await (
        await hardhatEthers.getContractFactory("EtherVault")
    )
        .connect(signer)
        .deploy();

    await etherVault.connect(signer).init(addressManager.address);

    await etherVault.connect(signer).authorize(bridge.address, true);

    await etherVault.connect(signer).authorize(await signer.getAddress(), true);

    await addressManager.setAddress(
        `${srcChain}.ether_vault`,
        etherVault.address
    );

    await signer.sendTransaction({
        to: etherVault.address,
        value: BigNumber.from(100000000),
        gasLimit: 1000000,
    });

    await addressManager.setAddress(`${destChain}.bridge`, bridge.address);

    return { bridge, etherVault };
}

async function sendMessage(
    bridge: Bridge,
    m: Message
): Promise<{
    bridge: Bridge;
    signal: any;
    messageSentEvent: any;
    message: Message;
    tx: ethers.ContractTransaction;
}> {
    const expectedAmount = m.depositValue + m.callValue + m.processingFee;

    const tx = await bridge.sendMessage(m, {
        value: expectedAmount,
    });

    const receipt = await tx.wait();

    const [messageSentEvent] = receipt.events as any as Event[];

    const { signal, message } = (messageSentEvent as any).args;

    return { bridge, messageSentEvent, signal, message, tx };
}

async function processMessage(
    l1Bridge: Bridge,
    l2Bridge: Bridge,
    signal: string,
    provider: ethers.providers.JsonRpcProvider,
    headerSync: TestHeaderSync,
    message: Message
): Promise<{
    tx: ethers.ContractTransaction;
    signalProof: string;
    block: Block;
    blockHeader: BlockHeader;
}> {
    const sender = l1Bridge.address;

    const key = getSignalSlot(sender, signal);

    const { block, blockHeader } = await getBlockHeader(provider);

    await headerSync.setSyncedHeader(block.hash);

    const signalProof = await getSignalProof(
        provider,
        l1Bridge.address,
        key,
        block.number,
        blockHeader
    );

    const tx = await l2Bridge.processMessage(message, signalProof);
    return { tx, signalProof, block, blockHeader };
}

async function sendAndProcessMessage(
    provider: ethers.providers.JsonRpcProvider,
    headerSync: TestHeaderSync,
    m: Message,
    l1Bridge: Bridge,
    l2Bridge: Bridge
): Promise<{
    tx: ethers.ContractTransaction;
    message: Message;
    signal: string;
    signalProof: string;
}> {
    const { signal, message } = await sendMessage(l1Bridge, m);
    const { tx, signalProof } = await processMessage(
        l1Bridge,
        l2Bridge,
        signal,
        provider,
        headerSync,
        message
    );
    return { tx, signal, message, signalProof };
}

export { deployBridge, sendMessage, processMessage, sendAndProcessMessage };
