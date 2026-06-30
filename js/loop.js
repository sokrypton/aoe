// ---- MAIN LOOP ----
function update(){
  if(gameOver||!gameStarted)return;
  tick++;
  let current=[...entities];
  current.forEach(e=>{
    if(entities.includes(e)){
      if(e.type==='unit')updateUnit(e);
      else updateBuilding(e);
    }
  });
  separateUnits();
  refreshPopulationCounts();
  updateAI();
  refreshPopulationCounts();
}

// Soft unit separation: push overlapping units apart (AoE2 collision)
function separateUnits(){
  let units=entities.filter(e=>e.type==='unit');
  let sep=0.08;
  let minDist=0.5;
  for(let i=0;i<units.length;i++){
    for(let j=i+1;j<units.length;j++){
      let a=units[i], b=units[j];
      // Skip units actively gathering on a resource tile
      let aGathering=a.gatherX>=0&&a.path.length===0;
      let bGathering=b.gatherX>=0&&b.path.length===0;
      let dx=a.x-b.x, dy=a.y-b.y;
      let d=Math.sqrt(dx*dx+dy*dy);
      if(d<minDist&&d>0.01){
        let push=sep*(minDist-d)/d;
        let px=dx*push, py=dy*push;
        if(a.path.length===0&&!aGathering){
          let nax=a.x+px, nay=a.y+py;
          if(walkable(Math.round(nax),Math.round(nay),a.id)){a.x=nax;a.y=nay;}
        }
        if(b.path.length===0&&!bGathering){
          let nbx=b.x-px, nby=b.y-py;
          if(walkable(Math.round(nbx),Math.round(nby),b.id)){b.x=nbx;b.y=nby;}
        }
      } else if(d<=0.01){
        if(a.path.length===0&&!aGathering){
          let nax=a.x+Math.random()*0.3-0.15;
          let nay=a.y+Math.random()*0.3-0.15;
          if(walkable(Math.round(nax),Math.round(nay),a.id)){a.x=nax;a.y=nay;}
        }
        if(b.path.length===0&&!bGathering){
          let nbx=b.x+Math.random()*0.3-0.15;
          let nby=b.y+Math.random()*0.3-0.15;
          if(walkable(Math.round(nbx),Math.round(nby),b.id)){b.x=nbx;b.y=nby;}
        }
      }
    }
  }
}
