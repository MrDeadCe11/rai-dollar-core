const Decimal = require("decimal.js");
const deploymentHelper = require("../utils/deploymentHelpers.js")
const { BNConverter } = require("../utils/BNConverter.js")
const testHelpers = require("../utils/testHelpers.js")

const LQTYStakingTester = artifacts.require('LQTYStakingTester')
const AggregatorTester = artifacts.require("AggregatorTester")
const TroveManagerTester = artifacts.require("TroveManagerTester")
const RateControlTester = artifacts.require("RateControlTester")
const NonPayable = artifacts.require("./NonPayable.sol")

const th = testHelpers.TestHelper
const timeValues = testHelpers.TimeValues
const dec = th.dec
const assertRevert = th.assertRevert

const toBN = th.toBN
const ZERO = th.toBN('0')
const ZERO_ADDRESS = th.ZERO_ADDRESS

const GAS_PRICE = 10000000

/* NOTE: These tests do not test for specific ETH and LUSD gain values. They only test that the 
 * gains are non-zero, occur when they should, and are in correct proportion to the user's stake. 
 *
 * Specific ETH/LUSD gain values will depend on the final fee schedule used, and the final choices for
 * parameters BETA and MINUTE_DECAY_FACTOR in the TroveManager, which are still TBD based on economic
 * modelling.
 * 
 */ 

contract('LQTYStaking revenue share tests', async accounts => {

  const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)
  
  const [owner, A, B, C, D, E, F, G, whale] = accounts;

  let priceFeed
  let lusdToken
  let sortedTroves
  let troveManager
  let feeRouter
  let globalFeeRouter
  let activePool
  let stabilityPool
  let defaultPool
  let borrowerOperations
  let lqtyStaking
  let lqtyToken
  let collateralToken

  let contracts

  const openTrove = async (params) => th.openTrove(contracts, params)

  beforeEach(async () => {
    contracts = await deploymentHelper.deployLiquityCore()
    contracts.aggregator = await AggregatorTester.new()
    contracts.troveManager = await TroveManagerTester.new()
    contracts.rateControl = await RateControlTester.new()
    contracts = await deploymentHelper.deployLUSDTokenTester(contracts)
    const LQTYContracts = await deploymentHelper.deployLQTYTesterContractsHardhat(bountyAddress, lpRewardsAddress, multisig)
    
    await deploymentHelper.connectLQTYContracts(LQTYContracts)
    await deploymentHelper.connectCoreContracts(contracts, LQTYContracts)
    await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, contracts)

    nonPayable = await NonPayable.new() 
    priceFeed = contracts.priceFeedTestnet
    lusdToken = contracts.lusdToken
    sortedTroves = contracts.sortedTroves
    aggregator = contracts.aggregator
    troveManager = contracts.troveManager
    feeRouter = contracts.feeRouter
    globalFeeRouter = contracts.globalFeeRouter
    activePool = contracts.activePool
    stabilityPool = contracts.stabilityPool
    defaultPool = contracts.defaultPool
    borrowerOperations = contracts.borrowerOperations
    hintHelpers = contracts.hintHelpers
    collateralToken = contracts.collateralToken

    lqtyToken = LQTYContracts.lqtyToken
    lqtyStaking = LQTYContracts.lqtyStaking

    await th.mintCollateralTokensAndApproveActivePool(contracts, [owner, A, B, C, D, E, F, G, whale], web3.utils.toWei('15000', 'ether'))
    globalFeeRouterInterface = (await ethers.getContractAt("GlobalFeeRouter", globalFeeRouter.address)).interface;

  })

  it('stake(): reverts if amount is zero', async () => {
    // FF time one year so owner can transfer LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

    // multisig transfers LQTY to staker A
    await lqtyToken.transfer(A, dec(100, 18), {from: multisig})

    // console.log(`A lqty bal: ${await lqtyToken.balanceOf(A)}`)

    // A makes stake
    await lqtyToken.approve(lqtyStaking.address, dec(100, 18), {from: A})
    await assertRevert(lqtyStaking.stake(0, {from: A}), "LQTYStaking: Amount must be non-zero")
  })

  // skipped because it's not relevant since collateral fee now stays in trove
  it.skip("ETH fee per LQTY staked increases when a redemption fee is triggered and totalStakes > 0", async () => {
    await openTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    await openTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
    await openTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
    await openTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })

    // FF time one year so owner can transfer LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

    // multisig transfers LQTY to staker A
    await lqtyToken.transfer(A, dec(100, 18), {from: multisig, gasPrice: GAS_PRICE})

    // console.log(`A lqty bal: ${await lqtyToken.balanceOf(A)}`)

    // A makes stake
    await lqtyToken.approve(lqtyStaking.address, dec(100, 18), {from: A})
    await lqtyStaking.stake(dec(100, 18), {from: A})

    // Check ETH fee per unit staked is zero
    const F_Collateral_Before = await lqtyStaking.F_Collateral()
    assert.equal(F_Collateral_Before, '0')

    const B_BalBeforeREdemption = await lusdToken.balanceOf(B)
    // B redeems
    const redemptionTx = await th.redeemCollateralAndGetTxObject(B, contracts, dec(100, 18), GAS_PRICE)
    
    const B_BalAfterRedemption = await lusdToken.balanceOf(B)
    assert.isTrue(B_BalAfterRedemption.lt(B_BalBeforeREdemption))

    // check ETH fee emitted in event is non-zero
    const emittedCollateralFee = toBN((await th.getEmittedRedemptionValues(redemptionTx))[3])
    assert.isTrue(emittedCollateralFee.gt(toBN('0')))

    // Check ETH fee per unit staked has increased by correct amount
    const F_Collateral_After = await lqtyStaking.F_Collateral()

    // Expect fee per unit staked = fee/100, since there is 100 LUSD totalStaked
    const expected_F_Collateral_After = emittedCollateralFee.div(toBN('100')) 

    assert.isTrue(expected_F_Collateral_After.eq(F_Collateral_After))
  })
  // skipped because it's not relevant since collateral fee now stays in trove
  it.skip("ETH fee per LQTY staked doesn't change when a redemption fee is triggered and totalStakes == 0", async () => {
    await openTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    await openTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
    await openTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
    await openTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
    await openTrove({ extraLUSDAmount: toBN(dec(50000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

    // FF time one year so owner can transfer LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

    // multisig transfers LQTY to staker A
    await lqtyToken.transfer(A, dec(100, 18), {from: multisig, gasPrice: GAS_PRICE})

    // Check ETH fee per unit staked is zero
    const F_Collateral_Before = await lqtyStaking.F_Collateral()
    assert.equal(F_Collateral_Before, '0')

    const B_BalBeforeREdemption = await lusdToken.balanceOf(B)
    // B redeems
    const redemptionTx = await th.redeemCollateralAndGetTxObject(B, contracts, dec(100, 18), GAS_PRICE)
    
    const B_BalAfterRedemption = await lusdToken.balanceOf(B)
    assert.isTrue(B_BalAfterRedemption.lt(B_BalBeforeREdemption))

    // check ETH fee emitted in event is non-zero
    const emittedCollateralFee = toBN((await th.getEmittedRedemptionValues(redemptionTx))[3])
    assert.isTrue(emittedCollateralFee.gt(toBN('0')))

    // Check ETH fee per unit staked has not increased 
    const F_Collateral_After = await lqtyStaking.F_Collateral()
    assert.equal(F_Collateral_After, '0')
  })

  // skipped because it's not relevant since collateral fee now stays in trove
  it.skip("LUSD fee per LQTY staked increases when a redemption fee is triggered and totalStakes > 0", async () => {
    await openTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    await openTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
    await openTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
    await openTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
    await openTrove({ extraLUSDAmount: toBN(dec(50000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

    // FF time one year so owner can transfer LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

    // multisig transfers LQTY to staker A
    await lqtyToken.transfer(A, dec(100, 18), {from: multisig})

    // A makes stake
    await lqtyToken.approve(lqtyStaking.address, dec(100, 18), {from: A})
    await lqtyStaking.stake(dec(100, 18), {from: A})

    // Check LUSD fee per unit staked is zero
    const F_LUSD_Before = await lqtyStaking.F_LUSD()
    assert.equal(F_LUSD_Before, '0')

    const B_BalBeforeREdemption = await lusdToken.balanceOf(B)
    // B redeems
    const redemptionTx = await th.redeemCollateralAndGetTxObject(B, contracts, dec(100, 18), gasPrice= GAS_PRICE)
    
    const B_BalAfterRedemption = await lusdToken.balanceOf(B)
    assert.isTrue(B_BalAfterRedemption.lt(B_BalBeforeREdemption))

    // Check base rate is now non-zero
    const baseRate = await aggregator.baseRate()
    assert.isTrue(baseRate.gt(toBN('0')))

    // D draws debt
    const tx = await borrowerOperations.withdrawLUSD(dec(27, 18), D, D, {from: D})
    
    // Check LUSD fee per unit staked has increased by correct amount
    //const F_LUSD_After = await lqtyStaking.F_LUSD()

    // Expect fee per unit staked = fee/100, since there is 100 LUSD totalStaked
    //const expected_F_LUSD_After = emittedLUSDFee.div(toBN('100')) 

    //assert.isTrue(expected_F_LUSD_After.eq(F_LUSD_After))
  })

  // skipped because it's not relevant since collateral fee now stays in trove
  it.skip("LUSD fee per LQTY staked doesn't change when a redemption fee is triggered and totalStakes == 0", async () => {
    await openTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    await openTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
    await openTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
    await openTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
    await openTrove({ extraLUSDAmount: toBN(dec(50000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

    // FF time one year so owner can transfer LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

    // multisig transfers LQTY to staker A
    await lqtyToken.transfer(A, dec(100, 18), {from: multisig})

    // Check LUSD fee per unit staked is zero
    const F_LUSD_Before = await lqtyStaking.F_Collateral()
    assert.equal(F_LUSD_Before, '0')

    const B_BalBeforeREdemption = await lusdToken.balanceOf(B)
    // B redeems
    const redemptionTx = await th.redeemCollateralAndGetTxObject(B, contracts, dec(100, 18), gasPrice = GAS_PRICE)
    
    const B_BalAfterRedemption = await lusdToken.balanceOf(B)
    assert.isTrue(B_BalAfterRedemption.lt(B_BalBeforeREdemption))

    // Check base rate is now non-zero
    const baseRate = await aggregator.baseRate()
    assert.isTrue(baseRate.gt(toBN('0')))

    // D draws debt
    const tx = await borrowerOperations.withdrawLUSD(dec(27, 18), D, D, {from: D})
    
    // Check LUSD fee value in event is non-zero
    /*
    const emittedLUSDFee = toBN(th.getLUSDFeeFromLUSDBorrowingEvent(tx))
    assert.isTrue(emittedLUSDFee.gt(toBN('0')))
    
    // Check LUSD fee per unit staked did not increase, is still zero
    const F_LUSD_After = await lqtyStaking.F_LUSD()
    assert.equal(F_LUSD_After, '0')
    */
  })

  it("LQTY Staking: A single staker earns all LQTY fees that go to staking", async () => {
    await openTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    await openTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
    await openTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
    await openTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
    await openTrove({ extraLUSDAmount: toBN(dec(50000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

    await stabilityPool.provideToSP(dec(1,18), ZERO_ADDRESS, {from : D})
    whaleNICR = await contracts.troveManager.getNominalICR(whale)
    ANICR = await contracts.troveManager.getNominalICR(A)
    BNICR = await contracts.troveManager.getNominalICR(B)
    CNICR = await contracts.troveManager.getNominalICR(C)
    DNICR = await contracts.troveManager.getNominalICR(D)

    trove1 = await contracts.sortedTroves.getFirst()
    trove2 = await contracts.sortedTroves.getNext(trove1)
    trove3 = await contracts.sortedTroves.getNext(trove2)
    trove4 = await contracts.sortedTroves.getNext(trove3)
    trove5 = await contracts.sortedTroves.getNext(trove4)
    trove6 = await contracts.sortedTroves.getNext(trove5)

    // Give E a least 200
    await openTrove({ extraLUSDAmount: toBN(200), ICR: toBN(dec(2, 18)), extraParams: { from: E } })
    // provideToSP()
    await stabilityPool.provideToSP(200, ZERO_ADDRESS, { from: E })

    // FF time one year so owner can transfer LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

  
    await contracts.troveManager.drip()

    trove1 = await contracts.sortedTroves.getFirst()
    trove2 = await contracts.sortedTroves.getNext(trove1)
    trove3 = await contracts.sortedTroves.getNext(trove2)
    trove4 = await contracts.sortedTroves.getNext(trove3)
    trove5 = await contracts.sortedTroves.getNext(trove4)
    trove6 = await contracts.sortedTroves.getNext(trove5)

    whaleNICR = await contracts.troveManager.getNominalICR(whale)
    ANICR = await contracts.troveManager.getNominalICR(A)
    BNICR = await contracts.troveManager.getNominalICR(B)
    CNICR = await contracts.troveManager.getNominalICR(C)
    DNICR = await contracts.troveManager.getNominalICR(D)

    // multisig transfers LQTY to staker A
    await lqtyToken.transfer(A, dec(100, 18), {from: multisig})

    // A makes stake
    await lqtyToken.approve(lqtyStaking.address, dec(100, 18), {from: A})
    await lqtyStaking.stake(dec(100, 18), {from: A})

    const B_BalBeforeREdemption = await lusdToken.balanceOf(B)

    freq  = await globalFeeRouter.distributionFreq()

    // fast forward so GlobalDrip distributes fee
    await th.fastForwardTime(freq,  web3.currentProvider)

    // B redeems
    const redemptionTx_1 = await th.redeemCollateralAndGetTxObject(B, contracts, dec(100, 18), gasPrice = GAS_PRICE)

    lusdGain1 = th.getRawEventArgByName(redemptionTx_1, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toStaking")
    console.log("lusdGain1 " + toBN(lusdGain1))

    const B_BalAfterRedemption = await lusdToken.balanceOf(B)
    assert.isTrue(B_BalAfterRedemption.lt(B_BalBeforeREdemption))

    // check ETH fee 1 emitted in event is non-zero
    const emittedCollateralFee_1 = toBN((await th.getEmittedRedemptionValues(redemptionTx_1))[3])
    assert.isTrue(emittedCollateralFee_1.gt(toBN('0')))

    const C_BalBeforeREdemption = await lusdToken.balanceOf(C)

    // fast forward so GlobalDrip distributes fee
    await th.fastForwardTime(freq,  web3.currentProvider)
    // C redeems
    const redemptionTx_2 = await th.redeemCollateralAndGetTxObject(C, contracts, dec(100, 18), gasPrice = GAS_PRICE)
    lusdGain2 = th.getRawEventArgByName(redemptionTx_2, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toStaking")
    
    const C_BalAfterRedemption = await lusdToken.balanceOf(C)
    assert.isTrue(C_BalAfterRedemption.lt(C_BalBeforeREdemption))
 
     // check ETH fee 2 emitted in event is non-zero
     const emittedCollateralFee_2 = toBN((await th.getEmittedRedemptionValues(redemptionTx_2))[3])
     assert.isTrue(emittedCollateralFee_2.gt(toBN('0')))

    // D draws debt
    const borrowingTx_1 = await borrowerOperations.withdrawLUSD(dec(104, 18), D, D, {from: D})
    
    // Check LUSD fee value in event is non-zero
    //const emittedLUSDFee_1 = toBN(th.getLUSDFeeFromLUSDBorrowingEvent(borrowingTx_1))
    //assert.isTrue(emittedLUSDFee_1.gt(toBN('0')))

    // B draws debt
    const borrowingTx_2 = await borrowerOperations.withdrawLUSD(dec(17, 18), B, B, {from: B})
    
    // Check LUSD fee value in event is non-zero
    //const emittedLUSDFee_2 = toBN(th.getLUSDFeeFromLUSDBorrowingEvent(borrowingTx_2))
    //assert.isTrue(emittedLUSDFee_2.gt(toBN('0')))

    //const expectedTotalETHGain = emittedCollateralFee_1.add(emittedCollateralFee_2)
    const expectedTotalETHGain = toBN(0)
    //const expectedTotalLUSDGain = emittedLUSDFee_1.add(emittedLUSDFee_2)

    const A_ETHBalance_Before = toBN(await collateralToken.balanceOf(A))
    const A_LUSDBalance_Before = toBN(await lusdToken.balanceOf(A))

    // A un-stakes
    const GAS_Used = th.gasUsed(await lqtyStaking.unstake(dec(100, 18), {from: A, gasPrice: GAS_PRICE }))

    const A_ETHBalance_After = toBN(await collateralToken.balanceOf(A))
    const A_LUSDBalance_After = toBN(await lusdToken.balanceOf(A))

    const A_ETHGain = A_ETHBalance_After.sub(A_ETHBalance_Before)//.add(toBN(GAS_Used * GAS_PRICE))
    const A_LUSDGain = A_LUSDBalance_After.sub(A_LUSDBalance_Before)
    console.log("A_LUSDGain", A_LUSDGain.toString())

    expectedTotalLUSDGain = lusdGain1.add(lusdGain2)
    console.log("expectedTotalLUSDGain " + expectedTotalLUSDGain)
    assert.isAtMost(th.getDifference(expectedTotalETHGain, A_ETHGain), 1000)
    assert.isAtMost(th.getDifference(expectedTotalLUSDGain, A_LUSDGain), 1000)
  })

  // skipped because it's not relevant since collateral fee now stays in trove
  it.skip("stake(): Top-up sends out all accumulated ETH and LUSD gains to the staker", async () => { 
    await openTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    await openTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
    await openTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
    await openTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
    await openTrove({ extraLUSDAmount: toBN(dec(50000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

    // FF time one year so owner can transfer LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

    // multisig transfers LQTY to staker A
    await lqtyToken.transfer(A, dec(100, 18), {from: multisig})

    // A makes stake
    await lqtyToken.approve(lqtyStaking.address, dec(100, 18), {from: A})
    await lqtyStaking.stake(dec(50, 18), {from: A})

    const B_BalBeforeREdemption = await lusdToken.balanceOf(B)
    // B redeems
    const redemptionTx_1 = await th.redeemCollateralAndGetTxObject(B, contracts, dec(100, 18), gasPrice = GAS_PRICE)
    
    const B_BalAfterRedemption = await lusdToken.balanceOf(B)
    assert.isTrue(B_BalAfterRedemption.lt(B_BalBeforeREdemption))

    // check ETH fee 1 emitted in event is non-zero
    const emittedCollateralFee_1 = toBN((await th.getEmittedRedemptionValues(redemptionTx_1))[3])
    assert.isTrue(emittedCollateralFee_1.gt(toBN('0')))

    const C_BalBeforeREdemption = await lusdToken.balanceOf(C)
    // C redeems
    const redemptionTx_2 = await th.redeemCollateralAndGetTxObject(C, contracts, dec(100, 18), gasPrice = GAS_PRICE)
    
    const C_BalAfterRedemption = await lusdToken.balanceOf(C)
    assert.isTrue(C_BalAfterRedemption.lt(C_BalBeforeREdemption))
 
     // check ETH fee 2 emitted in event is non-zero
     const emittedCollateralFee_2 = toBN((await th.getEmittedRedemptionValues(redemptionTx_2))[3])
     assert.isTrue(emittedCollateralFee_2.gt(toBN('0')))

    // D draws debt
    const borrowingTx_1 = await borrowerOperations.withdrawLUSD(dec(104, 18), D, D, {from: D})
    
    // Check LUSD fee value in event is non-zero
    //const emittedLUSDFee_1 = toBN(th.getLUSDFeeFromLUSDBorrowingEvent(borrowingTx_1))
    //assert.isTrue(emittedLUSDFee_1.gt(toBN('0')))

    // B draws debt
    const borrowingTx_2 = await borrowerOperations.withdrawLUSD(dec(17, 18), B, B, {from: B})
    
    // Check LUSD fee value in event is non-zero
    //const emittedLUSDFee_2 = toBN(th.getLUSDFeeFromLUSDBorrowingEvent(borrowingTx_2))
    //assert.isTrue(emittedLUSDFee_2.gt(toBN('0')))

    const expectedTotalETHGain = emittedCollateralFee_1.add(emittedCollateralFee_2)
    //const expectedTotalLUSDGain = emittedLUSDFee_1.add(emittedLUSDFee_2)

    const A_ETHBalance_Before = toBN(await collateralToken.balanceOf(A))
    const A_LUSDBalance_Before = toBN(await lusdToken.balanceOf(A))

    // A tops up
    const GAS_Used = th.gasUsed(await lqtyStaking.stake(dec(50, 18), {from: A, gasPrice: GAS_PRICE }))

    const A_ETHBalance_After = toBN(await collateralToken.balanceOf(A))
    const A_LUSDBalance_After = toBN(await lusdToken.balanceOf(A))

    const A_ETHGain = A_ETHBalance_After.sub(A_ETHBalance_Before)//.add(toBN(GAS_Used * GAS_PRICE))
    const A_LUSDGain = A_LUSDBalance_After.sub(A_LUSDBalance_Before)

    expectedTotalLUSDGain = toBN('0')

    assert.isAtMost(th.getDifference(expectedTotalETHGain, A_ETHGain), 1000)
    assert.isAtMost(th.getDifference(expectedTotalLUSDGain, A_LUSDGain), 1000)
  })

  // skipped because it's not relevant since collateral fee now stays in trove
  it.skip("getPendingETHGain(): Returns the staker's correct pending ETH gain", async () => { 
    await openTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    await openTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
    await openTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
    await openTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
    await openTrove({ extraLUSDAmount: toBN(dec(50000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

    // FF time one year so owner can transfer LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

    // multisig transfers LQTY to staker A
    await lqtyToken.transfer(A, dec(100, 18), {from: multisig})

    // A makes stake
    await lqtyToken.approve(lqtyStaking.address, dec(100, 18), {from: A})
    await lqtyStaking.stake(dec(50, 18), {from: A})

    const B_BalBeforeREdemption = await lusdToken.balanceOf(B)
    // B redeems
    const redemptionTx_1 = await th.redeemCollateralAndGetTxObject(B, contracts, dec(100, 18), gasPrice = GAS_PRICE)
    
    const B_BalAfterRedemption = await lusdToken.balanceOf(B)
    assert.isTrue(B_BalAfterRedemption.lt(B_BalBeforeREdemption))

    // check ETH fee 1 emitted in event is non-zero
    const emittedCollateralFee_1 = toBN((await th.getEmittedRedemptionValues(redemptionTx_1))[3])
    assert.isTrue(emittedCollateralFee_1.gt(toBN('0')))

    const C_BalBeforeREdemption = await lusdToken.balanceOf(C)
    // C redeems
    const redemptionTx_2 = await th.redeemCollateralAndGetTxObject(C, contracts, dec(100, 18), gasPrice = GAS_PRICE)
    
    const C_BalAfterRedemption = await lusdToken.balanceOf(C)
    assert.isTrue(C_BalAfterRedemption.lt(C_BalBeforeREdemption))
 
     // check ETH fee 2 emitted in event is non-zero
     const emittedCollateralFee_2 = toBN((await th.getEmittedRedemptionValues(redemptionTx_2))[3])
     assert.isTrue(emittedCollateralFee_2.gt(toBN('0')))

    const expectedTotalETHGain = emittedCollateralFee_1.add(emittedCollateralFee_2)

    const A_ETHGain = await lqtyStaking.getPendingETHGain(A)

    assert.isAtMost(th.getDifference(expectedTotalETHGain, A_ETHGain), 1000)
  })

  // skipped because it's not relevant since collateral fee now stays in trove
  it.skip("getPendingLUSDGain(): Returns the staker's correct pending LUSD gain", async () => { 
    await openTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    await openTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
    await openTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
    await openTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
    await openTrove({ extraLUSDAmount: toBN(dec(50000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

    // FF time one year so owner can transfer LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

    // multisig transfers LQTY to staker A
    await lqtyToken.transfer(A, dec(100, 18), {from: multisig})

    // A makes stake
    await lqtyToken.approve(lqtyStaking.address, dec(100, 18), {from: A})
    await lqtyStaking.stake(dec(50, 18), {from: A})

    const B_BalBeforeREdemption = await lusdToken.balanceOf(B)
    // B redeems
    const redemptionTx_1 = await th.redeemCollateralAndGetTxObject(B, contracts, dec(100, 18), gasPrice = GAS_PRICE)
    
    const B_BalAfterRedemption = await lusdToken.balanceOf(B)
    assert.isTrue(B_BalAfterRedemption.lt(B_BalBeforeREdemption))

    // check ETH fee 1 emitted in event is non-zero
    const emittedCollateralFee_1 = toBN((await th.getEmittedRedemptionValues(redemptionTx_1))[3])
    assert.isTrue(emittedCollateralFee_1.gt(toBN('0')))

    const C_BalBeforeREdemption = await lusdToken.balanceOf(C)
    // C redeems
    const redemptionTx_2 = await th.redeemCollateralAndGetTxObject(C, contracts, dec(100, 18), gasPrice = GAS_PRICE)
    
    const C_BalAfterRedemption = await lusdToken.balanceOf(C)
    assert.isTrue(C_BalAfterRedemption.lt(C_BalBeforeREdemption))
 
     // check ETH fee 2 emitted in event is non-zero
     const emittedCollateralFee_2 = toBN((await th.getEmittedRedemptionValues(redemptionTx_2))[3])
     assert.isTrue(emittedCollateralFee_2.gt(toBN('0')))

    // D draws debt
    const borrowingTx_1 = await borrowerOperations.withdrawLUSD(dec(104, 18), D, D, {from: D})
    
    // Check LUSD fee value in event is non-zero
    //const emittedLUSDFee_1 = toBN(th.getLUSDFeeFromLUSDBorrowingEvent(borrowingTx_1))
    //assert.isTrue(emittedLUSDFee_1.gt(toBN('0')))

    // B draws debt
    const borrowingTx_2 = await borrowerOperations.withdrawLUSD(dec(17, 18), B, B, {from: B})
    
    // Check LUSD fee value in event is non-zero
    //const emittedLUSDFee_2 = toBN(th.getLUSDFeeFromLUSDBorrowingEvent(borrowingTx_2))
    //assert.isTrue(emittedLUSDFee_2.gt(toBN('0')))

    //const expectedTotalLUSDGain = emittedLUSDFee_1.add(emittedLUSDFee_2)
    const A_LUSDGain = await lqtyStaking.getPendingLUSDGain(A)
    console.log("A_LUSDGain", A_LUSDGain.toString())

    expectedTotalLUSDGain = toBN('0')
    assert.isAtMost(th.getDifference(expectedTotalLUSDGain, A_LUSDGain), 1000)
  })

  // - multi depositors, several rewards
  // skipped because it's not relevant since collateral fee now stays in trove
  it.skip("LQTY Staking: Multiple stakers earn the correct share of all ETH and LQTY fees, based on their stake size", async () => {
    await openTrove({ extraLUSDAmount: toBN(dec(10000, 18)), ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    await openTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
    await openTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
    await openTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
    await openTrove({ extraLUSDAmount: toBN(dec(50000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })
    await openTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: E } })
    await openTrove({ extraLUSDAmount: toBN(dec(50000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: F } })
    await openTrove({ extraLUSDAmount: toBN(dec(50000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: G } })

    // FF time one year so owner can transfer LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

    // multisig transfers LQTY to staker A, B, C
    await lqtyToken.transfer(A, dec(100, 18), {from: multisig})
    await lqtyToken.transfer(B, dec(200, 18), {from: multisig})
    await lqtyToken.transfer(C, dec(300, 18), {from: multisig})

    // A, B, C make stake
    await lqtyToken.approve(lqtyStaking.address, dec(100, 18), {from: A})
    await lqtyToken.approve(lqtyStaking.address, dec(200, 18), {from: B})
    await lqtyToken.approve(lqtyStaking.address, dec(300, 18), {from: C})
    await lqtyStaking.stake(dec(100, 18), {from: A})
    await lqtyStaking.stake(dec(200, 18), {from: B})
    await lqtyStaking.stake(dec(300, 18), {from: C})

    // Confirm staking contract holds 600 LQTY
    // console.log(`lqty staking LQTY bal: ${await lqtyToken.balanceOf(lqtyStaking.address)}`)
    assert.equal(await lqtyToken.balanceOf(lqtyStaking.address), dec(600, 18))
    assert.equal(await lqtyStaking.totalLQTYStaked(), dec(600, 18))

    // F redeems
    const redemptionTx_1 = await th.redeemCollateralAndGetTxObject(F, contracts, dec(45, 18), gasPrice = GAS_PRICE)
    const emittedCollateralFee_1 = toBN((await th.getEmittedRedemptionValues(redemptionTx_1))[3])
    assert.isTrue(emittedCollateralFee_1.gt(toBN('0')))

     // G redeems
     const redemptionTx_2 = await th.redeemCollateralAndGetTxObject(G, contracts, dec(197, 18), gasPrice = GAS_PRICE)
     const emittedCollateralFee_2 = toBN((await th.getEmittedRedemptionValues(redemptionTx_2))[3])
     assert.isTrue(emittedCollateralFee_2.gt(toBN('0')))

    // F draws debt
    const borrowingTx_1 = await borrowerOperations.withdrawLUSD(dec(104, 18), F, F, {from: F})
    //const emittedLUSDFee_1 = toBN(th.getLUSDFeeFromLUSDBorrowingEvent(borrowingTx_1))
    //assert.isTrue(emittedLUSDFee_1.gt(toBN('0')))

    // G draws debt
    const borrowingTx_2 = await borrowerOperations.withdrawLUSD(dec(17, 18), G, G, {from: G})
    //const emittedLUSDFee_2 = toBN(th.getLUSDFeeFromLUSDBorrowingEvent(borrowingTx_2))
    //assert.isTrue(emittedLUSDFee_2.gt(toBN('0')))

    // D obtains LQTY from owner and makes a stake
    await lqtyToken.transfer(D, dec(50, 18), {from: multisig})
    await lqtyToken.approve(lqtyStaking.address, dec(50, 18), {from: D})
    await lqtyStaking.stake(dec(50, 18), {from: D})

    // Confirm staking contract holds 650 LQTY
    assert.equal(await lqtyToken.balanceOf(lqtyStaking.address), dec(650, 18))
    assert.equal(await lqtyStaking.totalLQTYStaked(), dec(650, 18))

     // G redeems
     const redemptionTx_3 = await th.redeemCollateralAndGetTxObject(C, contracts, dec(197, 18), gasPrice = GAS_PRICE)
     const emittedCollateralFee_3 = toBN((await th.getEmittedRedemptionValues(redemptionTx_3))[3])
     assert.isTrue(emittedCollateralFee_3.gt(toBN('0')))

     // G draws debt
    const borrowingTx_3 = await borrowerOperations.withdrawLUSD(dec(17, 18), G, G, {from: G})
    //const emittedLUSDFee_3 = toBN(th.getLUSDFeeFromLUSDBorrowingEvent(borrowingTx_3))
    //assert.isTrue(emittedLUSDFee_3.gt(toBN('0')))
     
    /*  
    Expected rewards:

    A_ETH: (100* CollateralFee_1)/600 + (100* CollateralFee_2)/600 + (100*ETH_Fee_3)/650
    B_ETH: (200* CollateralFee_1)/600 + (200* CollateralFee_2)/600 + (200*ETH_Fee_3)/650
    C_ETH: (300* CollateralFee_1)/600 + (300* CollateralFee_2)/600 + (300*ETH_Fee_3)/650
    D_ETH:                                             (100*ETH_Fee_3)/650

    A_LUSD: (100*LUSDFee_1 )/600 + (100* LUSDFee_2)/600 + (100*LUSDFee_3)/650
    B_LUSD: (200* LUSDFee_1)/600 + (200* LUSDFee_2)/600 + (200*LUSDFee_3)/650
    C_LUSD: (300* LUSDFee_1)/600 + (300* LUSDFee_2)/600 + (300*LUSDFee_3)/650
    D_LUSD:                                               (100*LUSDFee_3)/650
    */

    // Expected ETH gains
    const expectedETHGain_A = toBN('100').mul(emittedCollateralFee_1).div( toBN('600'))
                            .add(toBN('100').mul(emittedCollateralFee_2).div( toBN('600')))
                            .add(toBN('100').mul(emittedCollateralFee_3).div( toBN('650')))

    const expectedETHGain_B = toBN('200').mul(emittedCollateralFee_1).div( toBN('600'))
                            .add(toBN('200').mul(emittedCollateralFee_2).div( toBN('600')))
                            .add(toBN('200').mul(emittedCollateralFee_3).div( toBN('650')))

    const expectedETHGain_C = toBN('300').mul(emittedCollateralFee_1).div( toBN('600'))
                            .add(toBN('300').mul(emittedCollateralFee_2).div( toBN('600')))
                            .add(toBN('300').mul(emittedCollateralFee_3).div( toBN('650')))

    const expectedETHGain_D = toBN('50').mul(emittedCollateralFee_3).div( toBN('650'))

    // Expected LUSD gains:
    /*
    const expectedLUSDGain_A = toBN('100').mul(emittedLUSDFee_1).div( toBN('600'))
                            .add(toBN('100').mul(emittedLUSDFee_2).div( toBN('600')))
                            .add(toBN('100').mul(emittedLUSDFee_3).div( toBN('650')))

    const expectedLUSDGain_B = toBN('200').mul(emittedLUSDFee_1).div( toBN('600'))
                            .add(toBN('200').mul(emittedLUSDFee_2).div( toBN('600')))
                            .add(toBN('200').mul(emittedLUSDFee_3).div( toBN('650')))

    const expectedLUSDGain_C = toBN('300').mul(emittedLUSDFee_1).div( toBN('600'))
                            .add(toBN('300').mul(emittedLUSDFee_2).div( toBN('600')))
                            .add(toBN('300').mul(emittedLUSDFee_3).div( toBN('650')))
    
    const expectedLUSDGain_D = toBN('50').mul(emittedLUSDFee_3).div( toBN('650'))
    */

    // Redemptions don't drip now. TODO: add drip() at end of redemptions
    const expectedLUSDGain_A = toBN('0')
    const expectedLUSDGain_B = toBN('0')
    const expectedLUSDGain_C = toBN('0')
    const expectedLUSDGain_D = toBN('0')

    const A_ETHBalance_Before = toBN(await collateralToken.balanceOf(A))
    const A_LUSDBalance_Before = toBN(await lusdToken.balanceOf(A))
    const B_ETHBalance_Before = toBN(await collateralToken.balanceOf(B))
    const B_LUSDBalance_Before = toBN(await lusdToken.balanceOf(B))
    const C_ETHBalance_Before = toBN(await collateralToken.balanceOf(C))
    const C_LUSDBalance_Before = toBN(await lusdToken.balanceOf(C))
    const D_ETHBalance_Before = toBN(await collateralToken.balanceOf(D))
    const D_LUSDBalance_Before = toBN(await lusdToken.balanceOf(D))

    // A-D un-stake
    const A_GAS_Used = th.gasUsed(await lqtyStaking.unstake(dec(100, 18), {from: A, gasPrice: GAS_PRICE }))
    const B_GAS_Used = th.gasUsed(await lqtyStaking.unstake(dec(200, 18), {from: B, gasPrice: GAS_PRICE }))
    const C_GAS_Used = th.gasUsed(await lqtyStaking.unstake(dec(400, 18), {from: C, gasPrice: GAS_PRICE }))
    const D_GAS_Used = th.gasUsed(await lqtyStaking.unstake(dec(50, 18), {from: D, gasPrice: GAS_PRICE }))

    // Confirm all depositors could withdraw

    //Confirm pool Size is now 0
    assert.equal((await lqtyToken.balanceOf(lqtyStaking.address)), '0')
    assert.equal((await lqtyStaking.totalLQTYStaked()), '0')

    // Get A-D ETH and LUSD balances
    const A_ETHBalance_After = toBN(await collateralToken.balanceOf(A))
    const A_LUSDBalance_After = toBN(await lusdToken.balanceOf(A))
    const B_ETHBalance_After = toBN(await collateralToken.balanceOf(B))
    const B_LUSDBalance_After = toBN(await lusdToken.balanceOf(B))
    const C_ETHBalance_After = toBN(await collateralToken.balanceOf(C))
    const C_LUSDBalance_After = toBN(await lusdToken.balanceOf(C))
    const D_ETHBalance_After = toBN(await collateralToken.balanceOf(D))
    const D_LUSDBalance_After = toBN(await lusdToken.balanceOf(D))

    // Get ETH and LUSD gains
    const A_ETHGain = A_ETHBalance_After.sub(A_ETHBalance_Before)//.add(toBN(A_GAS_Used * GAS_PRICE))
    const A_LUSDGain = A_LUSDBalance_After.sub(A_LUSDBalance_Before)
    const B_ETHGain = B_ETHBalance_After.sub(B_ETHBalance_Before)//.add(toBN(B_GAS_Used * GAS_PRICE))
    const B_LUSDGain = B_LUSDBalance_After.sub(B_LUSDBalance_Before)
    const C_ETHGain = C_ETHBalance_After.sub(C_ETHBalance_Before)//.add(toBN(C_GAS_Used * GAS_PRICE))
    const C_LUSDGain = C_LUSDBalance_After.sub(C_LUSDBalance_Before)
    const D_ETHGain = D_ETHBalance_After.sub(D_ETHBalance_Before)//.add(toBN(D_GAS_Used * GAS_PRICE))
    const D_LUSDGain = D_LUSDBalance_After.sub(D_LUSDBalance_Before)

    // Check gains match expected amounts
    assert.isAtMost(th.getDifference(expectedETHGain_A, A_ETHGain), 1000)
    assert.isAtMost(th.getDifference(expectedLUSDGain_A, A_LUSDGain), 1000)
    assert.isAtMost(th.getDifference(expectedETHGain_B, B_ETHGain), 1000)
    assert.isAtMost(th.getDifference(expectedLUSDGain_B, B_LUSDGain), 1000)
    assert.isAtMost(th.getDifference(expectedETHGain_C, C_ETHGain), 1000)
    assert.isAtMost(th.getDifference(expectedLUSDGain_C, C_LUSDGain), 1000)
    assert.isAtMost(th.getDifference(expectedETHGain_D, D_ETHGain), 1000)
    assert.isAtMost(th.getDifference(expectedLUSDGain_D, D_LUSDGain), 1000)
  })
  // not relevant to erc20 collateral
  it.skip ("unstake(): reverts if caller has ETH gains and can't receive ETH",  async () => {
    await openTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })  
    await openTrove({ extraLUSDAmount: toBN(dec(20000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: A } })
    await openTrove({ extraLUSDAmount: toBN(dec(30000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: B } })
    await openTrove({ extraLUSDAmount: toBN(dec(40000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: C } })
    await openTrove({ extraLUSDAmount: toBN(dec(50000, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: D } })

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

    // multisig transfers LQTY to staker A and the non-payable proxy
    await lqtyToken.transfer(A, dec(100, 18), {from: multisig})
    await lqtyToken.transfer(nonPayable.address, dec(100, 18), {from: multisig})

    //  A makes stake
    const A_stakeTx = await lqtyStaking.stake(dec(100, 18), {from: A})
    assert.isTrue(A_stakeTx.receipt.status)

    //  A tells proxy to make a stake
    const proxystakeTxData = await th.getTransactionData('stake(uint256)', ['0x56bc75e2d63100000'])  // proxy stakes 100 LQTY
    await nonPayable.forward(lqtyStaking.address, proxystakeTxData, {from: A})


    // B makes a redemption, creating ETH gain for proxy
    const redemptionTx_1 = await th.redeemCollateralAndGetTxObject(B, contracts, dec(45, 18), gasPrice = GAS_PRICE)
    
    const proxy_ETHGain = await lqtyStaking.getPendingETHGain(nonPayable.address)
    assert.isTrue(proxy_ETHGain.gt(toBN('0')))

    // Expect this tx to revert: stake() tries to send nonPayable proxy's accumulated ETH gain (albeit 0),
    //  A tells proxy to unstake
    const proxyUnStakeTxData = await th.getTransactionData('unstake(uint256)', ['0x56bc75e2d63100000'])  // proxy stakes 100 LQTY
    const proxyUnstakeTxPromise = nonPayable.forward(lqtyStaking.address, proxyUnStakeTxData, {from: A})
   
    // but nonPayable proxy can not accept ETH - therefore stake() reverts.
    await assertRevert(proxyUnstakeTxPromise)
  })

  it("receive(): reverts when it receives ETH from an address that is not the Active Pool",  async () => { 
    const ethSendTxPromise1 = web3.eth.sendTransaction({to: lqtyStaking.address, from: A, value: dec(1, 'ether')})
    const ethSendTxPromise2 = web3.eth.sendTransaction({to: lqtyStaking.address, from: owner, value: dec(1, 'ether')})

    await assertRevert(ethSendTxPromise1)
    await assertRevert(ethSendTxPromise2)
  })

  it("unstake(): reverts if user has no stake",  async () => {  
    const unstakeTxPromise1 = lqtyStaking.unstake(1, {from: A})
    const unstakeTxPromise2 = lqtyStaking.unstake(1, {from: owner})

    await assertRevert(unstakeTxPromise1)
    await assertRevert(unstakeTxPromise2)
  })

  it('Test requireCallerIsTroveManager', async () => {
    const lqtyStakingTester = await LQTYStakingTester.new()
    await assertRevert(lqtyStakingTester.requireCallerIsTroveManager(), 'LQTYStaking: caller is not TroveM')
  })
})
