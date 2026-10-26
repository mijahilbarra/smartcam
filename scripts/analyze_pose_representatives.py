import sqlite3
import numpy as np
import json

def blob_to_vector(blob):
    if not blob or len(blob) != 2048:
        return None
    return np.frombuffer(blob, dtype=np.float32)

def cosine_similarity(v1, v2):
    return float(np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2)))

# Load staff profiles to exclude barber
b_conn = sqlite3.connect('data/barberia.db')
b_cur = b_conn.cursor()
b_cur.execute('SELECT embedding_blob FROM customer_embeddings WHERE customer_id="staff_barbero";')
staff_vecs = [blob_to_vector(r[0]) for r in b_cur.fetchall()]
staff_vecs = [v for v in staff_vecs if v is not None]

def is_staff(vec, threshold=0.46):
    if not staff_vecs or vec is None:
        return False
    for sv in staff_vecs:
        if np.dot(vec, sv) >= threshold:
            return True
    return False

def categorize_pose(pose):
    if not pose:
        return 'other'
    p = pose.lower()
    if p == 'frontal':
        return 'frontal'
    elif 'left' in p and not p.startswith('tilted'):
        return 'left'  # semi_left, profile_left
    elif 'right' in p and not p.startswith('tilted'):
        return 'right' # semi_right, profile_right
    elif p.startswith('tilted'):
        return 'tilted' # tilted_down*, tilted_up*
    return 'other'

exp_conn = sqlite3.connect('data/experiments.db')
exp_cur = exp_conn.cursor()

def analyze_video_clients(video_file, clients):
    print(f"\n=======================================================")
    print(f"   ANÁLISIS DE CLIENTES: {video_file}")
    print(f"=======================================================\n")
    
    overall_results = []
    
    for client in clients:
        c_id = client['id']
        name = client['name']
        s_sec = client['start_sec']
        e_sec = client['end_sec']
        
        # Query crops for this interval
        exp_cur.execute('''
            SELECT id, video_second, track_id, sharpness_score, pose, embedding_blob, landmarks_json
            FROM harvested_crops
            WHERE video_file = ? AND video_second >= ? AND video_second <= ? AND face_detected = 1
            ORDER BY video_second ASC
        ''', (video_file, s_sec, e_sec))
        
        rows = exp_cur.fetchall()
        
        # Group by category and filter staff
        grouped = {'frontal': [], 'left': [], 'right': [], 'tilted': []}
        all_client_crops = []
        
        for r in rows:
            crop_id, sec, track_id, sharpness, pose, blob, lm_json = r
            vec = blob_to_vector(blob)
            if vec is None:
                continue
            if is_staff(vec):
                continue
            
            cat = categorize_pose(pose)
            if cat in grouped:
                item = {
                    'id': crop_id,
                    'sec': sec,
                    'track_id': track_id,
                    'sharpness': sharpness or 0,
                    'pose': pose,
                    'vector': vec
                }
                grouped[cat].append(item)
                all_client_crops.append(item)
        
        # Calculate statistics per pose group
        stats = {}
        for cat in ['frontal', 'left', 'right', 'tilted']:
            items = grouped[cat]
            count = len(items)
            if count > 0:
                scores = [x['sharpness'] for x in items]
                avg_score = float(np.mean(scores))
                max_score = float(np.max(scores))
                # Best representative in this category
                best_item = max(items, key=lambda x: x['sharpness'])
            else:
                avg_score = 0.0
                max_score = 0.0
                best_item = None
            stats[cat] = {
                'count': count,
                'avg_sharpness': avg_score,
                'max_sharpness': max_score,
                'best': best_item
            }
        
        # Cross Cosine Similarity Analysis
        # Intra-group (Homologous)
        intra_sim = {}
        for cat in ['frontal', 'left', 'right', 'tilted']:
            items = grouped[cat]
            if len(items) >= 2:
                sims = []
                # sample up to 100 pairs
                step = max(1, len(items) // 15)
                sub = items[::step]
                for i in range(len(sub)):
                    for j in range(i + 1, len(sub)):
                        sims.append(np.dot(sub[i]['vector'], sub[j]['vector']))
                intra_sim[cat] = {
                    'avg': float(np.mean(sims)) if sims else 0.0,
                    'max': float(np.max(sims)) if sims else 0.0,
                    'min': float(np.min(sims)) if sims else 0.0
                }
            elif len(items) == 1:
                intra_sim[cat] = {'avg': 1.0, 'max': 1.0, 'min': 1.0}
            else:
                intra_sim[cat] = {'avg': None, 'max': None, 'min': None}
        
        # Inter-group (Orthogonal: Left vs Right, Frontal vs Left, Frontal vs Right, Tilted vs Frontal)
        inter_sim = {}
        pairs = [('left', 'right'), ('frontal', 'left'), ('frontal', 'right'), ('frontal', 'tilted'), ('left', 'tilted'), ('right', 'tilted')]
        for catA, catB in pairs:
            itemsA = grouped[catA]
            itemsB = grouped[catB]
            if itemsA and itemsB:
                sims = []
                stepA = max(1, len(itemsA) // 10)
                stepB = max(1, len(itemsB) // 10)
                for a in itemsA[::stepA]:
                    for b in itemsB[::stepB]:
                        sims.append(np.dot(a['vector'], b['vector']))
                inter_sim[f"{catA}_vs_{catB}"] = {
                    'avg': float(np.mean(sims)) if sims else 0.0,
                    'max': float(np.max(sims)) if sims else 0.0,
                    'min': float(np.min(sims)) if sims else 0.0
                }
            else:
                inter_sim[f"{catA}_vs_{catB}"] = {'avg': None, 'max': None, 'min': None}
        
        # Best Representative comparison (best of Left vs best of Right)
        best_reps = {cat: stats[cat]['best'] for cat in ['frontal', 'left', 'right', 'tilted']}
        rep_sims = {}
        for catA, catB in pairs:
            rA = best_reps[catA]
            rB = best_reps[catB]
            if rA and rB:
                rep_sims[f"{catA}_vs_{catB}"] = float(np.dot(rA['vector'], rB['vector']))
            else:
                rep_sims[f"{catA}_vs_{catB}"] = None
        
        client_res = {
            'id': c_id,
            'name': name,
            'interval': f"{int(s_sec//3600):02d}:{int((s_sec%3600)//60):02d}:{int(s_sec%60):02d} - {int(e_sec//3600):02d}:{int((e_sec%3600)//60):02d}:{int(e_sec%60):02d}",
            'total_crops': len(all_client_crops),
            'stats': stats,
            'intra_sim': intra_sim,
            'inter_sim': inter_sim,
            'rep_sims': rep_sims
        }
        overall_results.append(client_res)
        
        print(f"--- {name} ({client_res['interval']}) - Total fotos: {client_res['total_crops']} ---")
        for cat in ['frontal', 'left', 'right', 'tilted']:
            st = stats[cat]
            intr = intra_sim[cat]
            intr_str = f"avg={intr['avg']:.3f}, max={intr['max']:.3f}" if intr['avg'] is not None else "N/A"
            print(f"  {cat.upper():7s}: {st['count']:4d} fotos | Nitidez: avg={st['avg_sharpness']:.1f}, max={st['max_sharpness']:.1f} | IntraSim: {intr_str}")
        
        lr_inter = inter_sim.get('left_vs_right', {})
        lr_str = f"avg={lr_inter['avg']:.3f}, max={lr_inter['max']:.3f}, min={lr_inter['min']:.3f}" if lr_inter.get('avg') is not None else "N/A"
        lr_rep = f"{rep_sims.get('left_vs_right'):.3f}" if rep_sims.get('left_vs_right') is not None else "N/A"
        print(f"  --> Cross Left vs Right: {lr_str} | BestRep Sim: {lr_rep}")
        
        fl_rep = f"{rep_sims.get('frontal_vs_left'):.3f}" if rep_sims.get('frontal_vs_left') is not None else "N/A"
        fr_rep = f"{rep_sims.get('frontal_vs_right'):.3f}" if rep_sims.get('frontal_vs_right') is not None else "N/A"
        print(f"  --> Frontal vs Left: {fl_rep} | Frontal vs Right: {fr_rep}")
        print()
        
    return overall_results

# Video 7h clients
gt_7h = [
    {'id': 'c1', 'name': 'Cliente #1', 'start_sec': 2406, 'end_sec': 4187},
    {'id': 'c2', 'name': 'Cliente #2', 'start_sec': 4323, 'end_sec': 7188},
    {'id': 'c3', 'name': 'Cliente #3', 'start_sec': 7245, 'end_sec': 10295},
    {'id': 'c4', 'name': 'Cliente #4', 'start_sec': 10330, 'end_sec': 13216},
    {'id': 'c5', 'name': 'Cliente #5', 'start_sec': 13413, 'end_sec': 16749},
    {'id': 'c6', 'name': 'Cliente #6', 'start_sec': 16811, 'end_sec': 19065}
]

res_7h = analyze_video_clients('barberia_stream_7h', gt_7h)

# Video 10h clients
gt_10h = [
    {'id': 'c1', 'name': 'Cliente #1', 'start_sec': 4247, 'end_sec': 4465},
    {'id': 'c2', 'name': 'Cliente #2', 'start_sec': 13307, 'end_sec': 15849},
    {'id': 'c3', 'name': 'Cliente #3', 'start_sec': 17022, 'end_sec': 18193},
    {'id': 'c4', 'name': 'Cliente #4', 'start_sec': 21610, 'end_sec': 22332},
    {'id': 'c5', 'name': 'Cliente #5', 'start_sec': 22363, 'end_sec': 23915},
    {'id': 'c6', 'name': 'Cliente #6', 'start_sec': 23915, 'end_sec': 24322},
    {'id': 'c7', 'name': 'Cliente #7', 'start_sec': 23951, 'end_sec': 24618},
    {'id': 'c8', 'name': 'Cliente #8', 'start_sec': 26817, 'end_sec': 29631},
    {'id': 'c9', 'name': 'Cliente #9', 'start_sec': 30031, 'end_sec': 30639},
    {'id': 'c10', 'name': 'Cliente #10', 'start_sec': 32842, 'end_sec': 33123}
]

res_10h = analyze_video_clients('barberia_stream_10h_oct17', gt_10h)

with open('data/pose_distribution_analysis.json', 'w') as f:
    json.dump({'res_7h': res_7h, 'res_10h': res_10h}, f, indent=2, default=lambda x: None)

print("Análisis completado y guardado en data/pose_distribution_analysis.json")
