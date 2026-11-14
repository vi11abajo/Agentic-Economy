const {createPublicClient,http,parseAbiItem,parseAbi,formatUnits,formatEther}=require("viem");
const c=createPublicClient({transport:http("https://rpc.pharos.xyz",{retryCount:5,retryDelay:800})});
const MC="0xcA11bde05977b3631167028862bE2a173976CA11";
const ev=parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
const T={USDC:["0xc879c018db60520f4355c26ed1a6d572cdac1815",6],WPROS:["0x52C48d4213107b20bC583832b0d951FB9CA8F0B0",18]};
const bal=parseAbi(["function balanceOf(address) view returns (uint256)","function getEthBalance(address) view returns (uint256)"]);
(async()=>{console.log("mc code",(await c.getCode({address:MC}))?.length);const n=await c.getBlockNumber();const seen=new Map();
for(const [s,[a,d]] of Object.entries(T)){for(let i=0n;i<20n;i++){const to=n-i*1000n;const logs=await c.getLogs({address:a,event:ev,fromBlock:to-999n,toBlock:to});for(const l of logs){for(const x of [l.args.from,l.args.to]){const k=x.toLowerCase();const v=seen.get(k)||{n:0,vol:0};v.n++;v.vol+=Number(formatUnits(l.args.value,d))*(s==="WPROS"?0.475:1);seen.set(k,v)}}}}
const addrs=[...seen.keys()].filter(a=>!/^0x0{40}$/.test(a));console.log("addresses",addrs.length);
const calls=addrs.flatMap(a=>[{address:MC,abi:bal,functionName:"getEthBalance",args:[a]},{address:T.USDC[0],abi:bal,functionName:"balanceOf",args:[a]},{address:T.WPROS[0],abi:bal,functionName:"balanceOf",args:[a]}]);
const res=await c.multicall({contracts:calls,multicallAddress:MC,batchSize:4096,allowFailure:true});
const out=addrs.map((a,i)=>{const [p,u,w]=res.slice(i*3,i*3+3).map(r=>r.result??0n);const pros=Number(formatEther(p)),usdc=Number(formatUnits(u,6)),wpros=Number(formatEther(w));return {a,n:seen.get(a).n,vol:Math.round(seen.get(a).vol),usd:Math.round((pros+wpros)*0.475+usdc),pros:Math.round(pros),usdc:Math.round(usdc),wpros:Math.round(wpros)}}).sort((x,y)=>y.usd-x.usd).slice(0,25);
for(const o of out){o.eoa=((await c.getCode({address:o.a}))||"0x")==="0x";await new Promise(r=>setTimeout(r,150))}
console.table(out)})()
