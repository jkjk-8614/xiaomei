"""Conservative product rectangle measurements; never measure the output canvas."""
import math
import numpy as np


class GeometryValidator:
    @staticmethod
    def unknown(reason):
        return dict(status='unknown', reason=reason, thicknessStatus='unknown',
                    thicknessReason='缺少可信侧视几何依据，无法验证厚度')

    @classmethod
    def validate(cls, target_ratio, corners=None, confidence=0, settings=None, shape='rectangle', camera_matrix=None):
        settings = settings or {}
        if shape != 'rectangle':
            return cls.unknown('首期仅校验可定位的近正视矩形产品')
        if not target_ratio or not math.isfinite(target_ratio) or target_ratio <= 0:
            return cls.unknown('没有有效的目标产品宽高比')
        if corners is None or confidence < .85:
            return cls.unknown('缺少可靠商品四角或产品定位置信度不足')
        try:
            p = np.asarray(corners, dtype=float)
            if p.shape != (4,2) or not np.isfinite(p).all():
                return cls.unknown('角点格式无效')
            edges = np.roll(p,-1,axis=0)-p
            lengths = np.linalg.norm(edges,axis=1)
            cross = edges[:,0]*np.roll(edges,-1,axis=0)[:,1]-edges[:,1]*np.roll(edges,-1,axis=0)[:,0]
            if min(lengths)<20 or not (np.all(cross>0) or np.all(cross<0)):
                return cls.unknown('角点不构成可靠凸四边形或商品过小')
            # Corner order is product TL, TR, BR, BL, established by identity matching.
            cosines = np.abs(np.sum(edges*np.roll(edges,-1,axis=0),axis=1)/(lengths*np.roll(lengths,-1)))
            perspective = max(abs(lengths[0]/lengths[2]-1),abs(lengths[1]/lengths[3]-1))
            if perspective > .04 or max(cosines) > math.sin(math.radians(3)):
                return cls.unknown('透视或斜视过大；缺少可确认的近正视几何，无法准确校正')
            # Unit square homography must not use target_ratio as its destination,
            # which would force every distorted product to pass.
            rows, values = [], []
            for (x,y),(u,v) in zip([(0,0),(1,0),(1,1),(0,1)],p):
                rows += [[x,y,1,0,0,0,-u*x,-u*y], [0,0,0,x,y,1,-v*x,-v*y]]
                values += [u,v]
            H = np.append(np.linalg.solve(rows,values),1).reshape(3,3)
            if camera_matrix is not None:
                inverse = np.linalg.inv(np.asarray(camera_matrix,dtype=float))
                a,b = inverse@H[:,0], inverse@H[:,1]
                if abs(float(a@b))/(np.linalg.norm(a)*np.linalg.norm(b))>.05:
                    return cls.unknown('相机标定与角点不符合矩形几何')
                measured = float(np.linalg.norm(a)/np.linalg.norm(b))
                method = 'calibrated-homography'
            else:
                # Rotation is removed by measuring corner edge vectors; mild opposite
                # edge perspective is averaged. Unobservable foreshortening is disclosed.
                measured = float((lengths[0]+lengths[2])/(lengths[1]+lengths[3]))
                method = 'near-frontal-opposite-edge-average'
            error = abs(measured/target_ratio-1)*100
            rectification = np.diag([measured,1,1])@np.linalg.inv(H)
            corrected = np.column_stack([p,np.ones(4)])@rectification.T
            corrected = corrected[:,:2]/corrected[:,2:3]
            tolerance = float(settings.get('tolerancePct',3))
            if not math.isfinite(tolerance) or not .1<=tolerance<=20:
                return cls.unknown('比例误差提示阈值无效')
            status = 'fail' if error>2*tolerance else 'warning' if error>tolerance or perspective>.01 else 'pass'
            result = cls.unknown('近正视产品正面相对比例检查；未标定时采用近似校正，不认证真实厘米精度')
            result.update(status=status,targetRatio=target_ratio,measuredRatio=measured,
                          relativeErrorPct=error,tolerancePct=tolerance,confidence=confidence,
                          outputCorners=p.tolist(),rectificationMethod=method,
                          rectificationMatrix=rectification.tolist(),rectifiedCorners=corrected.tolist(),
                          rectifiedFrontSize=[measured,1],perspectiveIndicator=perspective)
            return result
        except (ValueError, TypeError, np.linalg.LinAlgError):
            return cls.unknown('角点或透视校正数据无效')

    @classmethod
    def from_images(cls, source, source_mask, generated, dimensions):
        """Identity matching anchors output corners to the selected product only."""
        if dimensions['shape'] != 'rectangle':
            return cls.unknown('首期仅验证近正视矩形产品；当前形状无法验证')
        if source is None or source_mask is None:
            return cls.unknown('缺少原产品图或定位蒙版，不能区分商品与背景')
        try:
            import cv2
        except ImportError:
            return cls.unknown('未安装可选 OpenCV，无法自动定位商品四角')
        from product_fidelity import planar_geometry
        try:
            src=np.asarray(source.convert('RGB')); dst=np.asarray(generated.convert('RGB'))
            s=min(1,1200/max(source.size)); t=min(1,1200/max(generated.size))
            a=cv2.resize(src,None,fx=s,fy=s); b=cv2.resize(dst,None,fx=t,fy=t)
            orb=cv2.ORB_create(1800)
            kp,dp=orb.detectAndCompute(cv2.cvtColor(a,cv2.COLOR_RGB2GRAY),cv2.resize(np.asarray(source_mask), (a.shape[1],a.shape[0])))
            kq,dq=orb.detectAndCompute(cv2.cvtColor(b,cv2.COLOR_RGB2GRAY),None)
            if dp is None or dq is None:
                return cls.unknown('产品特征不足，无法可靠定位商品四角')
            pairs=cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(dp,dq,k=2)
            matches=[p[0] for p in pairs if len(p)==2 and p[0].distance<.7*p[1].distance]
            if len(matches)<16:
                return cls.unknown('对应产品特征不足，不能确认四角身份')
            p=np.float32([kp[m.queryIdx].pt for m in matches])/s
            q=np.float32([kq[m.trainIdx].pt for m in matches])/t
            transform,inliers=cv2.estimateAffinePartial2D(p,q,method=cv2.RANSAC,ransacReprojThreshold=3/t)
            if transform is None or inliers is None or inliers.sum()<16 or inliers.mean()<.85 or min(np.ptp(p[inliers.ravel().astype(bool)],axis=0)/source.size)<.3:
                return cls.unknown('产品定位置信度或特征覆盖不足')
            geometry=planar_geometry(source_mask,dst,transform)
            if not geometry.get('outputCorners'):
                return cls.unknown(geometry['reason'])
            # Establish semantic width axis using the near frontal source rectangle.
            original=np.asarray(geometry['sourceCorners']); actual=np.asarray(geometry['outputCorners'])
            start=np.argmin(original.sum(axis=1))
            order=[(start+i)%4 for i in range(4)]
            if abs(original[order[1],0]-original[order[0],0]) < abs(original[order[1],1]-original[order[0],1]):
                order=[(start-i)%4 for i in range(4)]
            source_check=cls.validate(dimensions['width']/dimensions['height'], original[order], 1)
            if source_check['status']!='pass':
                return cls.unknown('原产品图斜视、四角不可靠或与物理比例不一致，无法可靠建立宽高轴向')
            return cls.validate(dimensions['width']/dimensions['height'],actual[order],float(inliers.mean()),dimensions['validationSettings'])
        except (cv2.error, ValueError, TypeError):
            return cls.unknown('商品定位或轮廓解析失败')
