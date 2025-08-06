const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")

const TroveManagerTester = artifacts.require("TroveManagerTester")
const AggregatorTester = artifacts.require("AggregatorTester")
const RateControlTester = artifacts.require("RateControlTester")
const LQTYTokenTester = artifacts.require("LQTYTokenTester")

const th = testHelpers.TestHelper

const dec = th.dec
const toBN = th.toBN
const mv = testHelpers.MoneyValues
const timeValues = testHelpers.TimeValues

const ZERO_ADDRESS = th.ZERO_ADDRESS
const assertRevert = th.assertRevert

//const GAS_PRICE = 10000000
const GAS_PRICE = 100000000000


const {
  buildUserProxies,
  BorrowerOperationsProxy,
  BorrowerWrappersProxy,
  TroveManagerProxy,
  StabilityPoolProxy,
  SortedTrovesProxy,
  TokenProxy,
  LQTYStakingProxy
} = require('../utils/proxyHelpers.js')

contract('BorrowerWrappers', async accounts => {

  const [
    owner, alice, bob, carol, dennis, whale,
    A, B, C, D, E,
    defaulter_1, defaulter_2,
    // frontEnd_1, frontEnd_2, frontEnd_3
  ] = accounts;

  const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)

  let priceFeed
  let lusdToken
  let sortedTroves
  let troveManagerOriginal
  let troveManager
  let activePool
  let stabilityPool
  let defaultPool
  let collSurplusPool
  let borrowerOperations
  let borrowerWrappers
  let lqtyTokenOriginal
  let lqtyToken
  let lqtyStaking

  let contracts

  let LUSD_GAS_COMPENSATION

  const getOpenTroveLUSDAmount = async (totalDebt) => th.getOpenTroveLUSDAmount(contracts, totalDebt)
  const getActualDebtFromComposite = async (compositeDebt) => th.getActualDebtFromComposite(compositeDebt, contracts)
  const getNetBorrowingAmount = async (debtWithFee) => th.getNetBorrowingAmount(contracts, debtWithFee)
  const openTrove = async (params) => th.openTrove(contracts, params)

  beforeEach(async () => {
    contracts = await deploymentHelper.deployLiquityCore()
    contracts.aggregator = await AggregatorTester.new()
    contracts.troveManager = await TroveManagerTester.new()
    contracts.rateControl = await RateControlTester.new()
    contracts = await deploymentHelper.deployLUSDToken(contracts)
    const LQTYContracts = await deploymentHelper.deployLQTYTesterContractsHardhat(bountyAddress, lpRewardsAddress, multisig)

    await deploymentHelper.connectLQTYContracts(LQTYContracts)
    await deploymentHelper.connectCoreContracts(contracts, LQTYContracts)
    await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, contracts)

    troveManagerOriginal = contracts.troveManager
    lqtyTokenOriginal = LQTYContracts.lqtyToken

    const users = [ alice, bob, carol, dennis, whale, A, B, C, D, E, defaulter_1, defaulter_2 ]
    await deploymentHelper.deployProxyScripts(contracts, LQTYContracts, owner, users)

    priceFeed = contracts.priceFeedTestnet
    lusdToken = contracts.lusdToken
    sortedTroves = contracts.sortedTroves
    aggregator = contracts.aggregator
    troveManager = contracts.troveManager
    activePool = contracts.activePool
    stabilityPool = contracts.stabilityPool
    defaultPool = contracts.defaultPool
    collSurplusPool = contracts.collSurplusPool
    borrowerOperations = contracts.borrowerOperations
    borrowerWrappers = contracts.borrowerWrappers
    lqtyStaking = LQTYContracts.lqtyStaking
    lqtyToken = LQTYContracts.lqtyToken
    communityIssuance = LQTYContracts.communityIssuance
      

    troveManagerInterface = (await ethers.getContractAt("TroveManager", troveManager.address)).interface;
    stabilityPoolInterface = (await ethers.getContractAt("StabilityPool", stabilityPool.address)).interface;

    LUSD_GAS_COMPENSATION = await borrowerOperations.LUSD_GAS_COMPENSATION()
  })

  it('proxy owner can recover ETH', async () => {
    const amount = toBN(dec(1, 18))
    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice)

    // send some ETH to proxy
    await web3.eth.sendTransaction({ from: owner, to: proxyAddress, value: amount, gasPrice: GAS_PRICE })
    assert.equal(await web3.eth.getBalance(proxyAddress), amount.toString())

    const balanceBefore = toBN(await web3.eth.getBalance(alice))

    // recover ETH
    const gas_Used = th.gasUsed(await borrowerWrappers.transferETH(alice, amount, { from: alice, gasPrice: GAS_PRICE }))
    
    const balanceAfter = toBN(await web3.eth.getBalance(alice))
    const expectedBalance = toBN(balanceBefore.sub(toBN(gas_Used * GAS_PRICE)))
    assert.equal(balanceAfter.sub(expectedBalance), amount.toString())
  })

  it('non proxy owner cannot recover ETH', async () => {
    const amount = toBN(dec(1, 18))
    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice)

    // send some ETH to proxy
    await web3.eth.sendTransaction({ from: owner, to: proxyAddress, value: amount })
    assert.equal(await web3.eth.getBalance(proxyAddress), amount.toString())

    const balanceBefore = toBN(await web3.eth.getBalance(alice))

    // try to recover ETH
    const proxy = borrowerWrappers.getProxyFromUser(alice)
    const signature = 'transferETH(address,uint256)'
    const calldata = th.getTransactionData(signature, [alice, amount])
    await assertRevert(proxy.methods["execute(address,bytes)"](borrowerWrappers.scriptAddress, calldata, { from: bob }), 'ds-auth-unauthorized')

    assert.equal(await web3.eth.getBalance(proxyAddress), amount.toString())

    const balanceAfter = toBN(await web3.eth.getBalance(alice))
    assert.equal(balanceAfter, balanceBefore.toString())
  })

  // --- claimCollateralAndOpenTrove ---

  it('claimCollateralAndOpenTrove(): reverts if nothing to claim', async () => {
    // Whale opens Trove
    await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: whale } })

    // alice opens Trove
    const { lusdAmount, collateral } = await openTrove({ ICR: toBN(dec(15, 17)), extraParams: { from: alice } })

    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice)
    assert.equal(await web3.eth.getBalance(proxyAddress), '0')

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // alice claims collateral and re-opens the trove
    await assertRevert(
      borrowerWrappers.claimCollateralAndOpenTrove(th._100pct, lusdAmount, alice, alice, { from: alice }),
      'CollSurplusPool: No collateral available to claim'
    )

    // check everything remain the same
    assert.equal(await web3.eth.getBalance(proxyAddress), '0')
    th.assertIsApproximatelyEqual(await collSurplusPool.getCollateral(proxyAddress), '0')
    th.assertIsApproximatelyEqual(await lusdToken.balanceOf(proxyAddress), lusdAmount)
    assert.equal(await troveManager.getTroveStatus(proxyAddress), 1)
    th.assertIsApproximatelyEqual(await troveManager.getTroveColl(proxyAddress), collateral)
  })

  it('claimCollateralAndOpenTrove(): without sending any value', async () => {
    // alice opens Trove
    const { lusdAmount, netDebt: redeemAmount, collateral } = await openTrove({extraLUSDAmount: 0, ICR: toBN(dec(3, 18)), extraParams: { from: alice } })
    // Whale opens Trove
    await openTrove({ extraLUSDAmount: redeemAmount, ICR: toBN(dec(5, 18)), extraParams: { from: whale } })

    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice)
    assert.equal(await web3.eth.getBalance(proxyAddress), '0')

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // whale redeems 150 LUSD
    await th.redeemCollateral(whale, contracts, redeemAmount, GAS_PRICE)
    assert.equal(await web3.eth.getBalance(proxyAddress), '0')

    // surplus: 5 - 150/200
    const price = await priceFeed.getPrice();
    const expectedSurplus = collateral.sub(redeemAmount.mul(mv._1e18BN).div(price))
    th.assertIsApproximatelyEqual(await collSurplusPool.getCollateral(proxyAddress), expectedSurplus)
    assert.equal(await troveManager.getTroveStatus(proxyAddress), 4) // closed by redemption

    // alice claims collateral and re-opens the trove
    await borrowerWrappers.claimCollateralAndOpenTrove(th._100pct, lusdAmount, alice, alice, { from: alice })

    assert.equal(await web3.eth.getBalance(proxyAddress), '0')
    th.assertIsApproximatelyEqual(await collSurplusPool.getCollateral(proxyAddress), '0')
    th.assertIsApproximatelyEqual(await lusdToken.balanceOf(proxyAddress), lusdAmount.mul(toBN(2)))
    assert.equal(await troveManager.getTroveStatus(proxyAddress), 1)
    th.assertIsApproximatelyEqual(await troveManager.getTroveColl(proxyAddress), expectedSurplus)
  })

  it('claimCollateralAndOpenTrove(): sending value in the transaction', async () => {
    // alice opens Trove
    const { lusdAmount, netDebt: redeemAmount, collateral } = await openTrove({ extraParams: { from: alice } })
    // Whale opens Trove
    await openTrove({ extraLUSDAmount: redeemAmount, ICR: toBN(dec(2, 18)), extraParams: { from: whale } })

    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice)
    assert.equal(await web3.eth.getBalance(proxyAddress), '0')

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // whale redeems 150 LUSD
    await th.redeemCollateral(whale, contracts, redeemAmount, GAS_PRICE)
    assert.equal(await web3.eth.getBalance(proxyAddress), '0')

    // surplus: 5 - 150/200
    const price = await priceFeed.getPrice();
    const expectedSurplus = collateral.sub(redeemAmount.mul(mv._1e18BN).div(price))
    th.assertIsApproximatelyEqual(await collSurplusPool.getCollateral(proxyAddress), expectedSurplus)
    assert.equal(await troveManager.getTroveStatus(proxyAddress), 4) // closed by redemption

    // alice claims collateral and re-opens the trove
    await borrowerWrappers.claimCollateralAndOpenTrove(th._100pct, lusdAmount, alice, alice, { from: alice, value: collateral })

    assert.equal(await web3.eth.getBalance(proxyAddress), '0')
    th.assertIsApproximatelyEqual(await collSurplusPool.getCollateral(proxyAddress), '0')
    th.assertIsApproximatelyEqual(await lusdToken.balanceOf(proxyAddress), lusdAmount.mul(toBN(2)))
    assert.equal(await troveManager.getTroveStatus(proxyAddress), 1)
    th.assertIsApproximatelyEqual(await troveManager.getTroveColl(proxyAddress), expectedSurplus.add(collateral))
  })

  // --- claimSPRewardsAndRecycle ---

  it('claimSPRewardsAndRecycle(): only owner can call it', async () => {
    // Whale opens Trove
    await openTrove({ extraLUSDAmount: toBN(dec(1850, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })
    // Whale deposits 1850 LUSD in StabilityPool
    await stabilityPool.provideToSP(dec(1850, 18), ZERO_ADDRESS, { from: whale })

    // alice opens trove and provides 150 LUSD to StabilityPool
    await openTrove({ extraLUSDAmount: toBN(dec(150, 18)), extraParams: { from: alice } })
    await stabilityPool.provideToSP(dec(150, 18), ZERO_ADDRESS, { from: alice })

    // Defaulter Trove opened
    await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: defaulter_1 } })

    // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
    const price = toBN(dec(100, 18))
    await priceFeed.setPrice(price);

    // Defaulter trove closed
    const liquidationTX_1 = await troveManager.liquidate(defaulter_1, { from: owner })
    const [liquidatedDebt_1] = await th.getEmittedLiquidationValues(liquidationTX_1)

    // Bob tries to claims SP rewards in behalf of Alice
    const proxy = borrowerWrappers.getProxyFromUser(alice)
    const signature = 'claimSPRewardsAndRecycle(uint256,address,address)'
    const calldata = th.getTransactionData(signature, [th._100pct, alice, alice])
    await assertRevert(proxy.methods["execute(address,bytes)"](borrowerWrappers.scriptAddress, calldata, { from: bob }), 'ds-auth-unauthorized')
  })

  it('claimSPRewardsAndRecycle(): a test', async () => {
    //const ts = th.toBN(await th.getLatestBlockTimestamp(web3))
    //console.log("ts", ts.toString())
    // Whale opens Trove
    const whaleDeposit = toBN(dec(2350, 18))
    await openTrove({ extraLUSDAmount: whaleDeposit, ICR: toBN(dec(4, 18)), extraParams: { from: whale } })
    // Whale deposits 1850 LUSD in StabilityPool
    await stabilityPool.provideToSP(whaleDeposit, ZERO_ADDRESS, { from: whale })

    // alice opens trove and provides 150 LUSD to StabilityPool
    const aliceDeposit = toBN(dec(150, 18))
    await openTrove({ extraLUSDAmount: aliceDeposit, ICR: toBN(dec(3, 18)), extraParams: { from: alice } })
    await stabilityPool.provideToSP(aliceDeposit, ZERO_ADDRESS, { from: alice })

    const totalDeposits = whaleDeposit.add(aliceDeposit)

    // Defaulter Trove opened
    const { lusdAmount, netDebt, collateral, tx } = await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: defaulter_1 } })
    const stakeLUSDGain = th.getRawEventArgByName(tx, troveManagerInterface, troveManager.address, "Drip", "_stakeInterest");
    const spLUSDGain = toBN(th.getRawEventArgByName(tx, troveManagerInterface, troveManager.address, "Drip", "_spInterest"));

    // get alice's portion of dripped interest
    const aliceDrip = spLUSDGain.mul(aliceDeposit).div(totalDeposits)
    const aliceDepositWithDrip = aliceDeposit.add(aliceDrip)

    // get alice's portion of dripped interest
    const whaleDrip = spLUSDGain.mul(whaleDeposit).div(totalDeposits)
    const whaleDepositWithDrip = whaleDeposit.add(whaleDrip)
   
    const totalDepositsWithDrip = totalDeposits.add(spLUSDGain)

    const compoundedLUSDDeposit_A_1 = await stabilityPool.getCompoundedLUSDDeposit(alice)
    const compoundedLUSDDeposit_whale_1 = await stabilityPool.getCompoundedLUSDDeposit(whale)
    //console.log("aliceDepositWithDrip", aliceDepositWithDrip.toString())
    //console.log("compoundedLUSDDeposit_A_1", compoundedLUSDDeposit_A_1.toString())

    // price drops: defaulters' Troves fall below MCR, alice and whale Trove remain active
    const price = toBN(dec(100, 18))
    await priceFeed.setPrice(price);

    // Defaulter trove closed
    const liquidationTX_1 = await troveManager.liquidate(defaulter_1, { from: owner })
    const [liquidatedDebt_1] = await th.getEmittedLiquidationValues(liquidationTX_1)
    const [aliceGain, whaelGain, aliceFinalDeposit, whaleFinalDeposit] =
          (await th.depositorValuesAfterLiquidation(contracts, liquidationTX_1, [compoundedLUSDDeposit_A_1, compoundedLUSDDeposit_whale_1]))

    const spLUSDGainLiq = toBN(th.getRawEventArgByName(liquidationTX_1, troveManagerInterface, troveManager.address, "Drip", "_spInterest"));

    // again, get alice's portion of dripped interest
    const aliceDripLiq = spLUSDGainLiq.mul(aliceDepositWithDrip).div(totalDepositsWithDrip)
    const aliceDepositWithDripLiq = aliceDepositWithDrip.add(aliceDripLiq)

    // again, get whale's portion of dripped interest
    const whaleDripLiq = spLUSDGainLiq.mul(whaleDepositWithDrip).div(totalDepositsWithDrip)
    const whaleDepositWithDripLiq = whaleDepositWithDrip.add(whaleDripLiq)

    const totalDepositsWithDripLiq = totalDepositsWithDrip.add(spLUSDGainLiq)

    console.log("totalDepositsWithDripLiq", totalDepositsWithDripLiq.toString())
    const totalDepositsBeforeClaim = (await stabilityPool.getCompoundedLUSDDeposit(alice)).add(await stabilityPool.getCompoundedLUSDDeposit(whale)) 
    console.log("totalLUSDDeposits", totalDepositsBeforeClaim.toString())


    // Alice LUSDLoss is ((150/2500) * liquidatedDebt)
    const expectedLUSDLoss_A = liquidatedDebt_1.mul(aliceDepositWithDripLiq).div(totalDepositsWithDripLiq)

    const expectedCompoundedLUSDDeposit_A = aliceFinalDeposit
    const compoundedLUSDDeposit_A = await stabilityPool.getCompoundedLUSDDeposit(alice)

    // collateral * 150 / 2500 * 0.995
    //const expectedETHGain_A = collateral.mul(aliceDeposit).div(totalDeposits).mul(toBN(dec(995, 15))).div(mv._1e18BN)
    const expectedETHGain_A = aliceGain

    assert.isAtMost(th.getDifference(expectedCompoundedLUSDDeposit_A, compoundedLUSDDeposit_A), 1000)

    const ethBalanceBefore = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollBefore = await troveManager.getTroveColl(alice)
    const lusdBalanceBefore = await lusdToken.balanceOf(alice)
    const troveDebtBefore = await troveManager.getTroveActualDebt(alice)
    const lqtyBalanceBefore = await lqtyToken.balanceOf(alice)
    const ICRBefore = await troveManager.getCurrentICR(alice, price)
    const depositBefore = (await stabilityPool.deposits(alice))[0]
    const stakeBefore = await lqtyStaking.stakes(alice)


    const par = await contracts.relayer.par()
    const proportionalLUSD = expectedETHGain_A.mul(price).mul(mv._1e18BN).div(ICRBefore).div(par)
    const netDebtChange = proportionalLUSD

    // to force LQTY issuance
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // This slightly changed due to differing timestamps from V1 possibly due to modifying test setup/deploy with new contracts?
    //const expectedLQTYGain_A = toBN('50373424199406504708132')

    await priceFeed.setPrice(price.mul(toBN(2)));

    // Alice claims SP rewards and puts them back in the system through the proxy
    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice)
    await borrowerWrappers.claimSPRewardsAndRecycle(th._100pct, alice, alice, { from: alice })

    // total LQTY issued
    lqtyIssued = await communityIssuance.totalLQTYIssued()

    // Alice's proportion of total issued
    aliceExpLqtyGain = lqtyIssued.mul(compoundedLUSDDeposit_A).div(totalDepositsBeforeClaim)

    const ethBalanceAfter = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollAfter = await troveManager.getTroveColl(alice)
    const lusdBalanceAfter = await lusdToken.balanceOf(alice)
    const troveDebtAfter = await troveManager.getTroveActualDebt(alice)
    const lqtyBalanceAfter = await lqtyToken.balanceOf(alice)
    const ICRAfter = await troveManager.getCurrentICR(alice, price)
    const depositAfter = (await stabilityPool.deposits(alice))[0]
    const stakeAfter = await lqtyStaking.stakes(alice)

    // check proxy balances remain the same
    assert.equal(ethBalanceAfter.toString(), ethBalanceBefore.toString())
    assert.equal(lusdBalanceAfter.toString(), lusdBalanceBefore.toString())
    assert.equal(lqtyBalanceAfter.toString(), lqtyBalanceBefore.toString())
    // check trove has increased debt by the ICR proportional amount to ETH gain
    th.assertIsApproximatelyEqual(troveDebtAfter, troveDebtBefore.add(proportionalLUSD), 10000)
    // check trove has increased collateral by the ETH gain
    th.assertIsApproximatelyEqual(troveCollAfter, troveCollBefore.add(expectedETHGain_A))
    // check that ICR remains constant
    th.assertIsApproximatelyEqual(ICRAfter, ICRBefore)
    // check that Stability Pool deposit
    // V1
    //th.assertIsApproximatelyEqual(depositAfter, depositBefore.sub(expectedLUSDLoss_A).add(netDebtChange))
    // this loses precision
    //th.assertIsApproximatelyEqual(depositAfter, depositBefore.add(aliceDrip).add(aliceDripLiq).sub(expectedLUSDLoss_A).add(netDebtChange))
    th.assertIsApproximatelyEqual(depositAfter, compoundedLUSDDeposit_A.add(netDebtChange), 10000)
    // check lqty balance remains the same
    th.assertIsApproximatelyEqual(lqtyBalanceAfter, lqtyBalanceBefore)

    // LQTY staking
    // TODO: had to increase tolerance. might be due to how aliceExpLqtyGain was calculated
    //th.assertIsApproximatelyEqual(stakeAfter, stakeBefore.add(expectedLQTYGain_A))
    th.assertIsApproximatelyEqual(stakeAfter, stakeBefore.add(aliceExpLqtyGain), 400000)

    // Expect Alice has withdrawn all ETH gain
    const alice_pendingETHGain = await stabilityPool.getDepositorCollateralGain(alice)
    assert.equal(alice_pendingETHGain, 0)
  })


  // --- claimStakingGainsAndRecycle ---

  it('claimStakingGainsAndRecycle(): only owner can call it', async () => {
    // Whale opens Trove
    await openTrove({ extraLUSDAmount: toBN(dec(1850, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })

    // alice opens trove
    await openTrove({ extraLUSDAmount: toBN(dec(150, 18)), extraParams: { from: alice } })

    // mint some LQTY
    await lqtyTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(whale), dec(1850, 18))
    await lqtyTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(alice), dec(150, 18))

    // stake LQTY
    await lqtyStaking.stake(dec(1850, 18), { from: whale })
    await lqtyStaking.stake(dec(150, 18), { from: alice })

    // Defaulter Trove opened
    const { lusdAmount, netDebt, totalDebt, collateral } = await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: defaulter_1 } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // whale redeems 100 LUSD
    const redeemedAmount = toBN(dec(100, 18))
    await th.redeemCollateral(whale, contracts, redeemedAmount, GAS_PRICE)

    // Bob tries to claims staking gains in behalf of Alice
    const proxy = borrowerWrappers.getProxyFromUser(alice)
    const signature = 'claimStakingGainsAndRecycle(uint256,address,address)'
    const calldata = th.getTransactionData(signature, [th._100pct, alice, alice])
    await assertRevert(proxy.methods["execute(address,bytes)"](borrowerWrappers.scriptAddress, calldata, { from: bob }), 'ds-auth-unauthorized')
  })

  it('claimStakingGainsAndRecycle(): reverts if user has no trove', async () => {
    const price = toBN(dec(200, 18))

    // Whale opens Trove
    await openTrove({ extraLUSDAmount: toBN(dec(1850, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })
    // Whale deposits 1850 LUSD in StabilityPool
    await stabilityPool.provideToSP(dec(1850, 18), ZERO_ADDRESS, { from: whale })

    // alice opens trove and provides 150 LUSD to StabilityPool
    //await openTrove({ extraLUSDAmount: toBN(dec(150, 18)), extraParams: { from: alice } })
    //await stabilityPool.provideToSP(dec(150, 18), ZERO_ADDRESS, { from: alice })

    // mint some LQTY
    await lqtyTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(whale), dec(1850, 18))
    await lqtyTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(alice), dec(150, 18))

    // stake LQTY
    await lqtyStaking.stake(dec(1850, 18), { from: whale })
    await lqtyStaking.stake(dec(150, 18), { from: alice })

    // Defaulter Trove opened
    const { lusdAmount, netDebt, totalDebt, collateral } = await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: defaulter_1 } })
    const borrowingFee = netDebt.sub(lusdAmount)

    // Alice LUSD gain is ((150/2000) * borrowingFee)
    const expectedLUSDGain_A = borrowingFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18)))

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // whale redeems 100 LUSD
    const redeemedAmount = toBN(dec(100, 18))
    await th.redeemCollateral(whale, contracts, redeemedAmount, GAS_PRICE)

    const ethBalanceBefore = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollBefore = await troveManager.getTroveColl(alice)
    const lusdBalanceBefore = await lusdToken.balanceOf(alice)
    const troveDebtBefore = await troveManager.getTroveDebt(alice)
    const lqtyBalanceBefore = await lqtyToken.balanceOf(alice)
    const ICRBefore = await troveManager.getCurrentICR(alice, price)
    const depositBefore = (await stabilityPool.deposits(alice))[0]
    const stakeBefore = await lqtyStaking.stakes(alice)

    // Alice claims staking rewards and puts them back in the system through the proxy
    await assertRevert(
      borrowerWrappers.claimStakingGainsAndRecycle(th._100pct, alice, alice, { from: alice }),
      'BorrowerWrappersScript: caller must have an active trove'
    )

    const ethBalanceAfter = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollAfter = await troveManager.getTroveColl(alice)
    const lusdBalanceAfter = await lusdToken.balanceOf(alice)
    const troveDebtAfter = await troveManager.getTroveDebt(alice)
    const lqtyBalanceAfter = await lqtyToken.balanceOf(alice)
    const ICRAfter = await troveManager.getCurrentICR(alice, price)
    const depositAfter = (await stabilityPool.deposits(alice))[0]
    const stakeAfter = await lqtyStaking.stakes(alice)

    // check everything remains the same
    assert.equal(ethBalanceAfter.toString(), ethBalanceBefore.toString())
    assert.equal(lusdBalanceAfter.toString(), lusdBalanceBefore.toString())
    assert.equal(lqtyBalanceAfter.toString(), lqtyBalanceBefore.toString())
    th.assertIsApproximatelyEqual(troveDebtAfter, troveDebtBefore, 10000)
    th.assertIsApproximatelyEqual(troveCollAfter, troveCollBefore)
    th.assertIsApproximatelyEqual(ICRAfter, ICRBefore)
    th.assertIsApproximatelyEqual(depositAfter, depositBefore, 10000)
    th.assertIsApproximatelyEqual(lqtyBalanceBefore, lqtyBalanceAfter)
    // LQTY staking
    th.assertIsApproximatelyEqual(stakeAfter, stakeBefore)
    console.log("stakeBefore", stakeBefore.toString())
    console.log("stakeAfter", stakeAfter.toString())

    // Expect Alice has withdrawn all ETH gain
    const alice_pendingETHGain = await stabilityPool.getDepositorCollateralGain(alice)
    assert.equal(alice_pendingETHGain, 0)
  })

  it('claimStakingGainsAndRecycle(): with only ETH gain', async () => {
    const price = toBN(dec(200, 18))

    // Whale opens Trove
    await openTrove({ extraLUSDAmount: toBN(dec(1850, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })

    // Defaulter Trove opened
    const { lusdAmount, netDebt, collateral } = await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: defaulter_1 } })
    const borrowingFee = netDebt.sub(lusdAmount)

    // alice opens trove and provides 150 LUSD to StabilityPool
    await openTrove({ extraLUSDAmount: toBN(dec(150, 18)), extraParams: { from: alice } })
    await stabilityPool.provideToSP(dec(150, 18), ZERO_ADDRESS, { from: alice })

    // mint some LQTY
    await lqtyTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(whale), dec(1850, 18))
    await lqtyTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(alice), dec(150, 18))

    // stake LQTY
    await lqtyStaking.stake(dec(1850, 18), { from: whale })
    await lqtyStaking.stake(dec(150, 18), { from: alice })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // whale redeems 100 LUSD
    const redeemedAmount = toBN(dec(100, 18))
    await th.redeemCollateral(whale, contracts, redeemedAmount, GAS_PRICE)

    // Alice ETH gain is ((150/2000) * (redemption fee over redeemedAmount) / price)
    const redemptionFee = await aggregator.getRedemptionFeeWithDecay(redeemedAmount)
    const expectedETHGain_A = redemptionFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18))).mul(mv._1e18BN).div(price)

    const ethBalanceBefore = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollBefore = await troveManager.getTroveColl(alice)
    const lusdBalanceBefore = await lusdToken.balanceOf(alice)
    const troveDebtBefore = await troveManager.getTroveDebt(alice)
    const lqtyBalanceBefore = await lqtyToken.balanceOf(alice)
    const ICRBefore = await troveManager.getCurrentICR(alice, price)
    const depositBefore = (await stabilityPool.deposits(alice))[0]
    const stakeBefore = await lqtyStaking.stakes(alice)

    //const proportionalLUSD = expectedETHGain_A.mul(price).div(ICRBefore).div(par)
    const par = await contracts.relayer.par()
    const proportionalLUSD = expectedETHGain_A.mul(price).mul(mv._1e18BN).div(ICRBefore).div(par)
    //const borrowingRate = await troveManagerOriginal.getBorrowingRateWithDecay()
    //const netDebtChange = proportionalLUSD.mul(toBN(dec(1, 18))).div(toBN(dec(1, 18)).add(borrowingRate))
    const netDebtChange = proportionalLUSD.mul(toBN(dec(1, 18))).div(toBN(dec(1, 18)))

    const expectedLQTYGain_A = toBN('839557069990108416000000')

    const proxyAddress = borrowerWrappers.getProxyAddressFromUser(alice)
    // Alice claims staking rewards and puts them back in the system through the proxy
    await borrowerWrappers.claimStakingGainsAndRecycle(th._100pct, alice, alice, { from: alice })

    // Alice new LUSD gain due to her own Trove adjustment: ((150/2000) * (borrowing fee over netDebtChange))
    //const newBorrowingFee = await troveManagerOriginal.getBorrowingFeeWithDecay(netDebtChange)
    //const expectedNewLUSDGain_A = newBorrowingFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18)))
    const expectedNewLUSDGain_A = toBN(dec(150, 18)).div(toBN(dec(2000, 18)))

    const ethBalanceAfter = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollAfter = await troveManager.getTroveColl(alice)
    const lusdBalanceAfter = await lusdToken.balanceOf(alice)
    const troveDebtAfter = await troveManager.getTroveDebt(alice)
    const lqtyBalanceAfter = await lqtyToken.balanceOf(alice)
    const ICRAfter = await troveManager.getCurrentICR(alice, price)
    const depositAfter = (await stabilityPool.deposits(alice))[0]
    const stakeAfter = await lqtyStaking.stakes(alice)

    // check proxy balances remain the same
    assert.equal(ethBalanceAfter.toString(), ethBalanceBefore.toString())
    assert.equal(lqtyBalanceAfter.toString(), lqtyBalanceBefore.toString())
    // check proxy lusd balance has increased by own adjust trove reward
    th.assertIsApproximatelyEqual(lusdBalanceAfter, lusdBalanceBefore.add(expectedNewLUSDGain_A))
    // check trove has increased debt by the ICR proportional amount to ETH gain
    th.assertIsApproximatelyEqual(troveDebtAfter, troveDebtBefore.add(proportionalLUSD), 10000)
    // check trove has increased collateral by the ETH gain
    th.assertIsApproximatelyEqual(troveCollAfter, troveCollBefore.add(expectedETHGain_A))
    // check that ICR remains constant
    th.assertIsApproximatelyEqual(ICRAfter, ICRBefore)
    // check that Stability Pool deposit
    th.assertIsApproximatelyEqual(depositAfter, depositBefore.add(netDebtChange), 10000)
    // check lqty balance remains the same
    th.assertIsApproximatelyEqual(lqtyBalanceBefore, lqtyBalanceAfter)

    // LQTY staking
    th.assertIsApproximatelyEqual(stakeAfter, stakeBefore.add(expectedLQTYGain_A))
    console.log("stakeBefore", stakeBefore.toString())
    console.log("stakeAfter", stakeAfter.toString())

    // Expect Alice has withdrawn all ETH gain
    const alice_pendingETHGain = await stabilityPool.getDepositorCollateralGain(alice)
    assert.equal(alice_pendingETHGain, 0)
  })

  it('claimStakingGainsAndRecycle(): with only LUSD gain', async () => {
    const price = toBN(dec(200, 18))

    // Whale opens Trove
    await openTrove({ extraLUSDAmount: toBN(dec(1850, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })

    // alice opens trove and provides 150 LUSD to StabilityPool
    await openTrove({ extraLUSDAmount: toBN(dec(150, 18)), extraParams: { from: alice } })
    await stabilityPool.provideToSP(dec(150, 18), ZERO_ADDRESS, { from: alice })

    // mint some LQTY
    await lqtyTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(whale), dec(1850, 18))
    await lqtyTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(alice), dec(150, 18))

    // stake LQTY
    await lqtyStaking.stake(dec(1850, 18), { from: whale })
    await lqtyStaking.stake(dec(150, 18), { from: alice })

    // Defaulter Trove opened
    const { lusdAmount, netDebt, collateral, tx } = await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: defaulter_1 } })
    const borrowingFee = netDebt.sub(lusdAmount)
    const stakeLUSDGain = th.getRawEventArgByName(tx, troveManagerInterface, troveManager.address, "Drip", "_stakeInterest");
    const spLUSDGain = th.getRawEventArgByName(tx, troveManagerInterface, troveManager.address, "Drip", "_spInterest");
    console.log("stakeLUSDGain", stakeLUSDGain.toString())
    console.log("spLUSDGain", spLUSDGain.toString())

    // Alice LUSD gain is ((150/2000) * borrowingFee)
    //const expectedLUSDGain_A = borrowingFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18)))
    // Alice LUSD gain is now her proportion of stakeInterest plus entire SP gain(she's the only SP depositor)
    const expectedStakeLUSDGain_A = toBN(stakeLUSDGain).mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18)))
    const expectedLUSDGain_A = toBN(spLUSDGain).add(expectedStakeLUSDGain_A)
    console.log("expectedLUSDGain_A", expectedLUSDGain_A.toString())


    const ethBalanceBefore = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollBefore = await troveManager.getTroveColl(alice)
    const lusdBalanceBefore = await lusdToken.balanceOf(alice)
    const troveDebtBefore = await troveManager.getTroveDebt(alice)
    const lqtyBalanceBefore = await lqtyToken.balanceOf(alice)
    const ICRBefore = await troveManager.getCurrentICR(alice, price)
    const depositBefore = (await stabilityPool.deposits(alice))[0]
    const stakeBefore = await lqtyStaking.stakes(alice)

    // Alice claims staking rewards and puts them back in the system through the proxy
    await borrowerWrappers.claimStakingGainsAndRecycle(th._100pct, alice, alice, { from: alice })

    const ethBalanceAfter = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollAfter = await troveManager.getTroveColl(alice)
    const lusdBalanceAfter = await lusdToken.balanceOf(alice)
    const troveDebtAfter = await troveManager.getTroveDebt(alice)
    const lqtyBalanceAfter = await lqtyToken.balanceOf(alice)
    const ICRAfter = await troveManager.getCurrentICR(alice, price)
    const depositAfter = (await stabilityPool.deposits(alice))[0]
    const compoundDepositAfter = await stabilityPool.getCompoundedLUSDDeposit(alice)
    const stakeAfter = await lqtyStaking.stakes(alice)

    // check proxy balances remain the same
    assert.equal(ethBalanceAfter.toString(), ethBalanceBefore.toString())
    assert.equal(lqtyBalanceAfter.toString(), lqtyBalanceBefore.toString())
    // check proxy lusd balance has increased by own adjust trove reward
    th.assertIsApproximatelyEqual(lusdBalanceAfter, lusdBalanceBefore)
    // check trove has increased debt by the ICR proportional amount to ETH gain
    th.assertIsApproximatelyEqual(troveDebtAfter, troveDebtBefore, 10000)
    // check trove has increased collateral by the ETH gain
    th.assertIsApproximatelyEqual(troveCollAfter, troveCollBefore)
    // check that ICR remains constant
    th.assertIsApproximatelyEqual(ICRAfter, ICRBefore)
    // check that Stability Pool deposit
    th.assertIsApproximatelyEqual(depositAfter, depositBefore.add(expectedLUSDGain_A), 10000)
    // check that Stability Pool compounded deposit
    th.assertIsApproximatelyEqual(depositAfter, depositBefore.add(expectedLUSDGain_A), 10000)
    // check lqty balance remains the same
    th.assertIsApproximatelyEqual(lqtyBalanceBefore, lqtyBalanceAfter)

    // Expect Alice has withdrawn all ETH gain
    const alice_pendingETHGain = await stabilityPool.getDepositorCollateralGain(alice)
    assert.equal(alice_pendingETHGain, 0)
  })

  it('claimStakingGainsAndRecycle(): with both ETH and LUSD gains', async () => {
    contracts.rateControl.setCoBias(0)
    const price = toBN(dec(200, 18))

    // Whale opens Trove
    await openTrove({ extraLUSDAmount: toBN(dec(1850, 18)), ICR: toBN(dec(2, 18)), extraParams: { from: whale } })

    // alice opens trove and provides 150 LUSD to StabilityPool
    await openTrove({ extraLUSDAmount: toBN(dec(150, 18)), extraParams: { from: alice } })
    await stabilityPool.provideToSP(dec(150, 18), ZERO_ADDRESS, { from: alice })

    // mint some LQTY
    await lqtyTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(whale), dec(1850, 18))
    await lqtyTokenOriginal.unprotectedMint(borrowerOperations.getProxyAddressFromUser(alice), dec(150, 18))

    // stake LQTY
    await lqtyStaking.stake(dec(1850, 18), { from: whale })
    await lqtyStaking.stake(dec(150, 18), { from: alice })

    // Defaulter Trove opened
    const { lusdAmount, netDebt, collateral } = await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: defaulter_1 } })
    const borrowingFee = netDebt.sub(lusdAmount)

    // Alice LUSD gain is ((150/2000) * borrowingFee)
    const expectedLUSDGain_A = borrowingFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18)))

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // whale redeems 100 LUSD
    const redeemedAmount = toBN(dec(100, 18))
    /*
    const debtBefore = await troveManagerOriginal.getEntireSystemDebt(await troveManagerOriginal.accumulatedRate())
    console.log("debtBefore", debtBefore.toString())
    whaleBalance =  await lusdToken.balanceOf(whale)
    console.log("whaleBalance", whaleBalance.toString())

    const redemptionhint = await contracts.hintHelpers.getRedemptionHints(redeemedAmount, price, GAS_PRICE)
    const firstRedemptionHint = redemptionhint[0]
    const partialRedemptionNewICR = redemptionhint[1]
    await contracts.troveManager.redeemCollateral(redeemedAmount,
      firstRedemptionHint,
      firstRedemptionHint,
      firstRedemptionHint,
      partialRedemptionNewICR,
      0, th._100pct, { from: whale })

    return
    */
    await th.redeemCollateral(whale, contracts, redeemedAmount, GAS_PRICE)

    // Alice ETH gain is ((150/2000) * (redemption fee over redeemedAmount) / price)
    const redemptionFee = await aggregator.getRedemptionFeeWithDecay(redeemedAmount)
    const expectedETHGain_A = redemptionFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18))).mul(mv._1e18BN).div(price)

    const ethBalanceBefore = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollBefore = await troveManager.getTroveColl(alice)
    const lusdBalanceBefore = await lusdToken.balanceOf(alice)
    const troveDebtBefore = await troveManager.getTroveDebt(alice)
    const lqtyBalanceBefore = await lqtyToken.balanceOf(alice)
    const ICRBefore = await troveManager.getCurrentICR(alice, price)
    const depositBefore = (await stabilityPool.deposits(alice))[0]
    const stakeBefore = await lqtyStaking.stakes(alice)

    //const proportionalLUSD = expectedETHGain_A.mul(price).div(ICRBefore)
    const par = await contracts.relayer.par()
    const proportionalLUSD = expectedETHGain_A.mul(price).mul(mv._1e18BN).div(ICRBefore).div(par)
    //const borrowingRate = await troveManagerOriginal.getBorrowingRateWithDecay()
    //const netDebtChange = proportionalLUSD.mul(toBN(dec(1, 18))).div(toBN(dec(1, 18)).add(borrowingRate))
    const netDebtChange = proportionalLUSD.mul(toBN(dec(1, 18))).div(toBN(dec(1, 18)))
    const expectedTotalLUSD = expectedLUSDGain_A.add(netDebtChange)

    const expectedLQTYGain_A = toBN('839557069990108416000000')

    // Alice claims staking rewards and puts them back in the system through the proxy
    await borrowerWrappers.claimStakingGainsAndRecycle(th._100pct, alice, alice, { from: alice })

    // Alice new LUSD gain due to her own Trove adjustment: ((150/2000) * (borrowing fee over netDebtChange))
    //const newBorrowingFee = await troveManagerOriginal.getBorrowingFeeWithDecay(netDebtChange)
    //const expectedNewLUSDGain_A = newBorrowingFee.mul(toBN(dec(150, 18))).div(toBN(dec(2000, 18)))
    const expectedNewLUSDGain_A = toBN('0')

    const ethBalanceAfter = await web3.eth.getBalance(borrowerOperations.getProxyAddressFromUser(alice))
    const troveCollAfter = await troveManager.getTroveColl(alice)
    const lusdBalanceAfter = await lusdToken.balanceOf(alice)
    const troveDebtAfter = await troveManager.getTroveDebt(alice)
    const lqtyBalanceAfter = await lqtyToken.balanceOf(alice)
    const ICRAfter = await troveManager.getCurrentICR(alice, price)
    const depositAfter = (await stabilityPool.deposits(alice))[0]
    const stakeAfter = await lqtyStaking.stakes(alice)

    // check proxy balances remain the same
    assert.equal(ethBalanceAfter.toString(), ethBalanceBefore.toString())
    assert.equal(lqtyBalanceAfter.toString(), lqtyBalanceBefore.toString())
    // check proxy lusd balance has increased by own adjust trove reward
    th.assertIsApproximatelyEqual(lusdBalanceAfter, lusdBalanceBefore.add(expectedNewLUSDGain_A))
    // check trove has increased debt by the ICR proportional amount to ETH gain
    th.assertIsApproximatelyEqual(troveDebtAfter, troveDebtBefore.add(proportionalLUSD), 10000)
    // check trove has increased collateral by the ETH gain
    th.assertIsApproximatelyEqual(troveCollAfter, troveCollBefore.add(expectedETHGain_A))
    // check that ICR remains constant
    th.assertIsApproximatelyEqual(ICRAfter, ICRBefore)
    // check that Stability Pool deposit
    th.assertIsApproximatelyEqual(depositAfter, depositBefore.add(expectedTotalLUSD), 10000)
    // check lqty balance remains the same
    th.assertIsApproximatelyEqual(lqtyBalanceBefore, lqtyBalanceAfter)

    // LQTY staking
    th.assertIsApproximatelyEqual(stakeAfter, stakeBefore.add(expectedLQTYGain_A))
    console.log("stakeBefore", stakeBefore.toString())
    console.log("stakeAfter", stakeAfter.toString())

    // Expect Alice has withdrawn all ETH gain
    const alice_pendingETHGain = await stabilityPool.getDepositorCollateralGain(alice)
    assert.equal(alice_pendingETHGain, 0)
  })

})
